// Export engine: crop page boxes, keep a subset of pages, and optionally
// downsample/re-encode images. Takes the mupdf module as a parameter so the
// same code runs in the browser worker and in Node tests.

const IDENTITY = [1, 0, 0, 1, 0, 0];
const SKIP_FILTERS = new Set(['JBIG2Decode', 'CCITTFaxDecode']);

/**
 * @param mupdf  the mupdf.js module
 * @param bytes  Uint8Array of the source PDF
 * @param opts   { boxes: (number[4]|null)[] per source page (PDF user space),
 *                 keep: 0-based source page indices to keep, in order,
 *                 rotate: degrees clockwise to add, per source page (multiples of 90),
 *                 compress: null | { ppi, quality },
 *                 encodeJpeg?: async (rgb, w, h, quality) => Uint8Array }
 *                 (optional RGB encoder; the browser's uses 4:2:0 chroma
 *                 subsampling, which makes photos much smaller than mupdf's 4:4:4)
 * @param progress  callback({ phase, done?, total? })
 */
export async function processPdf(mupdf, bytes, opts, progress = () => {}) {
  progress({ phase: 'open' });
  const doc = new mupdf.PDFDocument(bytes);
  bytes = null; // mupdf has its own copy; let the caller's buffer be freed
  const n = doc.countPages();

  opts.boxes?.forEach((b, i) => {
    if (!b || i >= n) return;
    const page = doc.findPage(i);
    page.put('MediaBox', b);
    page.put('CropBox', b);
    for (const k of ['BleedBox', 'TrimBox', 'ArtBox']) page.delete(k);
  });

  // Extra clockwise rotation per source page, added to any /Rotate it has.
  opts.rotate?.forEach((deg, i) => {
    if (!deg || i >= n) return;
    const page = doc.findPage(i);
    const cur = page.getInheritable('Rotate');
    page.put('Rotate', ((((cur.isNumber() ? cur.asNumber() : 0) + deg) % 360) + 360) % 360);
  });

  const keep = opts.keep ?? [...Array(n).keys()];
  if (keep.length === 0) throw new Error('No pages selected');
  if (keep.length !== n || keep.some((p, i) => p !== i)) {
    progress({ phase: 'pages' });
    doc.rearrangePages(keep);
  }

  const stats = opts.compress ? await compressImages(mupdf, doc, opts.compress, opts.encodeJpeg, progress) : null;

  progress({ phase: 'save' });
  const out = doc.saveToBuffer('garbage=deduplicate,compress=yes');
  const result = out.asUint8Array().slice();
  out.destroy?.();
  doc.destroy?.();
  return { bytes: result, stats };
}

/* ---------- image usage: how large is each image drawn? ---------- */

function collectImageUses(doc) {
  const uses = new Map(); // object number -> { ref, w, h } (largest drawn size, points)
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.findPage(i);
    const res = page.getInheritable('Resources');
    const contents = page.get('Contents');
    const parts = contents.isArray()
      ? Array.from({ length: contents.length }, (_, k) => contents.get(k))
      : [contents];
    for (const part of parts) {
      if (!part.isStream()) continue;
      scanContent(readBytes(part), res, IDENTITY, uses, 0, new Set());
    }
  }
  return uses;
}

function readBytes(streamObj) {
  const buf = streamObj.readStream();
  const bytes = buf.asUint8Array().slice();
  buf.destroy?.();
  return bytes;
}

function scanContent(bytes, res, startCtm, uses, depth, stack) {
  let ctm = startCtm;
  const saved = [];
  tokenize(bytes, (op, args) => {
    if (op === 'q') saved.push(ctm);
    else if (op === 'Q') ctm = saved.pop() ?? startCtm;
    else if (op === 'cm' && args.length >= 6) {
      const m = args.slice(-6);
      if (m.every((v) => typeof v === 'number')) ctm = mul(m, ctm);
    } else if (op === 'Do' && args.length && args[args.length - 1]?.name) {
      if (!res || !res.isDictionary()) return;
      const x = res.get('XObject', args[args.length - 1].name);
      if (!x.isStream()) return;
      const sub = x.get('Subtype').isName() ? x.get('Subtype').asName() : '';
      if (sub === 'Image' && x.isIndirect()) {
        const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
        const num = x.asIndirect();
        const u = uses.get(num) || { ref: x, w: 0, h: 0 };
        u.w = Math.max(u.w, w);
        u.h = Math.max(u.h, h);
        uses.set(num, u);
      } else if (sub === 'Form' && depth < 12) {
        const key = x.isIndirect() ? x.asIndirect() : -1;
        if (stack.has(key)) return;
        const fm = x.get('Matrix');
        const m = fm.isArray() && fm.length === 6 ? Array.from({ length: 6 }, (_, k) => fm.get(k).asNumber()) : IDENTITY;
        const fres = x.get('Resources');
        stack.add(key);
        scanContent(readBytes(x), fres.isDictionary() ? fres : res, mul(m, ctm), uses, depth + 1, stack);
        stack.delete(key);
      }
    }
  });
}

// PDF matrix product: m × n (apply m first, then n).
function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// Minimal content-stream tokenizer: reports each operator with the operands
// before it. Numbers become numbers, names become {name}, everything else null.
export function tokenize(buf, onOp) {
  const n = buf.length;
  const isWS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const str = (a, b) => { let s = ''; for (let k = a; k < b; k++) s += String.fromCharCode(buf[k]); return s; };
  const args = [];
  let i = 0;
  while (i < n) {
    const c = buf[i];
    if (isWS(c)) { i++; continue; }
    if (c === 37) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; }
    if (c === 40) {
      let depth = 1; i++;
      while (i < n && depth) {
        const d = buf[i];
        if (d === 92) { i += 2; continue; }
        if (d === 40) depth++; else if (d === 41) depth--;
        i++;
      }
      args.push(null); continue;
    }
    if (c === 60) {
      if (buf[i + 1] === 60) { i += 2; continue; }
      while (i < n && buf[i] !== 62) i++;
      i++; args.push(null); continue;
    }
    if (c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 41) { i++; continue; }
    if (c === 47) {
      let j = i + 1;
      while (j < n && !isWS(buf[j]) && !isDelim(buf[j])) j++;
      args.push({ name: str(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) });
      i = j; continue;
    }
    let j = i;
    while (j < n && !isWS(buf[j]) && !isDelim(buf[j])) j++;
    if (j === i) { i++; continue; }
    const tok = str(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { args.push(parseFloat(tok)); continue; }
    if (tok === 'true' || tok === 'false' || tok === 'null') { args.push(null); continue; }
    if (tok === 'ID') {
      // Inline image data: skip binary bytes up to a whitespace-delimited EI.
      i++;
      while (i < n - 1) {
        if (buf[i] === 69 && buf[i + 1] === 73 && isWS(buf[i - 1]) && (i + 2 >= n || isWS(buf[i + 2]))) { i += 2; break; }
        i++;
      }
      args.length = 0; continue;
    }
    onOp(tok, args);
    args.length = 0;
  }
}

/* ---------- image rewriting ---------- */

async function compressImages(mupdf, doc, { ppi = 200, quality = 82 }, encodeJpeg, progress) {
  progress({ phase: 'scan' });
  const uses = [...collectImageUses(doc).values()];
  const stats = { images: uses.length, rewritten: 0, before: 0, after: 0 };
  const doneMasks = new Set();
  for (let k = 0; k < uses.length; k++) {
    progress({ phase: 'images', done: k, total: uses.length });
    try {
      await rewriteImage(mupdf, doc, uses[k], ppi, quality, encodeJpeg, stats, doneMasks);
    } catch (err) {
      // Leave images we can't handle exactly as they were.
      console.warn('image skipped', uses[k].ref.asIndirect?.(), err?.message || err);
    }
  }
  progress({ phase: 'images', done: uses.length, total: uses.length });
  return stats;
}

function filterNames(f) {
  if (f.isName()) return [f.asName()];
  if (f.isArray()) return Array.from({ length: f.length }, (_, k) => f.get(k).asName());
  return [];
}

async function rewriteImage(mupdf, doc, u, ppi, quality, encodeJpeg, stats, doneMasks) {
  const obj = u.ref;
  if (doneMasks.has(obj.asIndirect())) return;
  const im = obj.get('ImageMask');
  if (im.isBoolean() && im.asBoolean()) return;
  const W = obj.get('Width').asNumber(), H = obj.get('Height').asNumber();
  const bpc = obj.get('BitsPerComponent');
  if (bpc.isNumber() && bpc.asNumber() < 8) return;
  if (W * H < 128 * 128 || u.w <= 0 || u.h <= 0) return;
  const filters = filterNames(obj.get('Filter'));
  if (filters.some((f) => SKIP_FILTERS.has(f))) return;
  const rawLen = obj.get('Length').asNumber();
  const isJpeg = filters.includes('DCTDecode');

  // Keep enough pixels for `ppi` at the largest size the image is drawn.
  let scale = Math.min(1, Math.max((u.w / 72) * ppi / W, (u.h / 72) * ppi / H));
  if (scale > 0.85) scale = 1;

  const image = doc.loadImage(obj);
  const nComp = image.getNumberOfComponents();
  // Not worth touching: already JPEG at a sensible size, or lossless data that
  // compresses well (logos, screenshots), which JPEG would only blur.
  if (scale === 1 && (isJpeg || rawLen / (W * H * nComp) < 0.3)) { image.destroy?.(); return; }

  let pix = image.toPixmap();
  image.destroy?.();
  if (pix.getAlpha()) { pix.destroy?.(); return; }

  const csObj = obj.get('ColorSpace');
  let keepCs = false;
  const n = pix.getNumberOfComponents();
  if (csObj.isName()) keepCs = (csObj.asName() === 'DeviceRGB' && n === 3) || (csObj.asName() === 'DeviceGray' && n === 1);
  else if (csObj.isArray() && csObj.get(0).asName() === 'ICCBased') {
    const N = csObj.get(1).get('N');
    keepCs = N.isNumber() && N.asNumber() === n && (n === 1 || n === 3);
  }
  if (!keepCs) {
    const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
    pix.destroy?.();
    pix = rgb;
  }

  const nw = Math.max(1, Math.round(W * scale)), nh = Math.max(1, Math.round(H * scale));
  const out = scale === 1 ? pix : resamplePixmap(mupdf, pix, nw, nh);
  let jpeg;
  if (encodeJpeg && out.getNumberOfComponents() === 3) {
    const px = out.getPixels(), stride = out.getStride();
    const rgb = new Uint8Array(nw * nh * 3); // copy out of the wasm heap before awaiting
    for (let y = 0; y < nh; y++) rgb.set(px.subarray(y * stride, y * stride + nw * 3), y * nw * 3);
    jpeg = await encodeJpeg(rgb, nw, nh, quality);
  } else {
    jpeg = out.asJPEG(quality, false).slice();
  }
  if (out !== pix) out.destroy?.();
  pix.destroy?.();

  if (jpeg.length >= rawLen * 0.9) return; // no real gain

  obj.writeRawStream(jpeg);
  obj.put('Filter', 'DCTDecode');
  obj.delete('DecodeParms');
  obj.delete('Decode');
  obj.put('Width', nw);
  obj.put('Height', nh);
  obj.put('BitsPerComponent', 8);
  if (!keepCs) obj.put('ColorSpace', 'DeviceRGB');
  stats.rewritten++;
  stats.before += rawLen;
  stats.after += jpeg.length;

  // Shrink the soft mask (transparency) along with the image.
  const sm = obj.get('SMask');
  if (scale < 1 && sm.isStream() && sm.isIndirect() && !doneMasks.has(sm.asIndirect())) {
    doneMasks.add(sm.asIndirect());
    const smImage = doc.loadImage(sm);
    const sp = smImage.toPixmap();
    smImage.destroy?.();
    if (sp.getNumberOfComponents() === 1 && !sp.getAlpha()) {
      const sw = Math.max(1, Math.round(sp.getWidth() * scale)), sh = Math.max(1, Math.round(sp.getHeight() * scale));
      const small = resamplePixmap(mupdf, sp, sw, sh);
      const px = small.getPixels(), stride = small.getStride();
      const raw = new Uint8Array(sw * sh);
      for (let y = 0; y < sh; y++) raw.set(px.subarray(y * stride, y * stride + sw), y * sw);
      small.destroy?.();
      sm.writeStream(raw); // stored uncompressed here; Flate-compressed on save
      sm.delete('Filter');
      sm.delete('DecodeParms');
      sm.delete('Decode');
      sm.put('Width', sw);
      sm.put('Height', sh);
      sm.put('BitsPerComponent', 8);
      sm.put('ColorSpace', 'DeviceGray');
    }
    sp.destroy?.();
  }
}

// Area-averaging (box filter) downscale; good quality for shrinking.
function resamplePixmap(mupdf, src, dw, dh) {
  const sw = src.getWidth(), sh = src.getHeight(), n = src.getNumberOfComponents();
  const dst = new mupdf.Pixmap(src.getColorSpace(), [0, 0, dw, dh], false);
  // Take heap views only after every allocation: memory growth detaches them.
  const sp = src.getPixels(), ss = src.getStride();
  const dp = dst.getPixels(), ds = dst.getStride();
  const xw = taps(sw, dw), yw = taps(sh, dh);

  const row = new Float32Array(dw * n);   // one horizontally-resampled source row
  const acc = new Float32Array(dw * n);   // vertical accumulator for one dest row
  let sy = 0;
  for (let y = 0; y < dh; y++) {
    acc.fill(0);
    for (let t = yw.start[y], e = t + yw.count[y], wi = yw.offset[y]; t < e; t++, wi++) {
      sy = t;
      const base = sy * ss;
      row.fill(0);
      for (let x = 0; x < dw; x++) {
        const o = x * n;
        for (let s = xw.start[x], se = s + xw.count[x], wj = xw.offset[x]; s < se; s++, wj++) {
          const w = xw.w[wj], p = base + s * n;
          for (let c = 0; c < n; c++) row[o + c] += sp[p + c] * w;
        }
      }
      const wy = yw.w[wi];
      for (let k = 0; k < acc.length; k++) acc[k] += row[k] * wy;
    }
    const ob = y * ds;
    for (let k = 0; k < acc.length; k++) dp[ob + k] = acc[k] + 0.5;
  }
  return dst;
}

function taps(s, d) {
  const ratio = s / d;
  const start = new Int32Array(d), count = new Int32Array(d), offset = new Int32Array(d);
  const ws = [];
  for (let x = 0; x < d; x++) {
    const a = x * ratio, b = Math.min(s, (x + 1) * ratio);
    const i0 = Math.floor(a), i1 = Math.min(s, Math.ceil(b));
    start[x] = i0; count[x] = i1 - i0; offset[x] = ws.length;
    for (let i = i0; i < i1; i++) ws.push((Math.min(b, i + 1) - Math.max(a, i)) / ratio);
  }
  return { start, count, offset, w: Float32Array.from(ws) };
}
