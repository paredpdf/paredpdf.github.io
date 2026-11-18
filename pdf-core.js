// Export engine: crop page boxes, keep a subset of pages, and optionally
// downsample/re-encode images. Takes the mupdf module as a parameter so the
// same code runs in the browser worker and in Node tests.

const IDENTITY = [1, 0, 0, 1, 0, 0];
const SKIP_FILTERS = new Set(['JBIG2Decode', 'CCITTFaxDecode']);

/**
 * @param mupdf  the mupdf.js module
 * @param bytes  Uint8Array of the source PDF, or several to merge in order:
 *               [{ bytes, password? }]. Page indices in opts then count
 *               through all of them.
 * @param opts   { boxes: (number[4]|null)[] per source page (PDF user space),
 *                 keep: 0-based source page indices to keep, in order,
 *                 rotate: degrees clockwise to add, per source page (multiples of 90),
 *                 password: the PDF's password, if it has one,
 *                 removePassword: save without encryption (otherwise a protected
 *                   PDF keeps its original passwords and permissions; merged
 *                   files are protected with the first password given),
 *                 split: [[output page indices], ...] to also return one PDF per
 *                   group as `parts`,
 *                 stripMetadata: remove author, software, dates, XMP metadata, editing
 *                   programs' private data, and photo metadata inside JPEGs (camera,
 *                   time, location); the document title is kept,
 *                 stamps: [{ page: 0-based source page, rect: [x0, y0, x1, y1] in PDF
 *                   user space, png: Uint8Array }] images (signatures) drawn on
 *                   top of the page, upright as the page is shown before any
 *                   added rotation,
 *                 compress: null | { ppi, quality },
 *                 encodeJpeg?: async (rgb, w, h, quality) => Uint8Array }
 *                 (optional RGB encoder; the browser's uses 4:2:0 chroma
 *                 subsampling, which makes photos much smaller than mupdf's 4:4:4)
 * @param progress  callback({ phase, done?, total? })
 */
export async function processPdf(mupdf, bytes, opts, progress = () => {}) {
  const doc = prepare(mupdf, bytes, opts, progress);
  bytes = null;

  const stats = opts.compress ? await compressImages(mupdf, doc, opts.compress, opts.encodeJpeg, progress) : null;

  progress({ phase: 'save' });
  const result = saveBytes(doc, opts.removePassword, doc.mergedPassword);
  const password = doc.mergedPassword ?? opts.password;
  doc.destroy?.();
  if (!opts.split) return { bytes: result, stats };

  // Each part is cut from the finished file, so they share its work.
  const parts = [];
  opts.split.forEach((group, k) => {
    progress({ phase: 'split', done: k, total: opts.split.length });
    const part = openDoc(mupdf, result, password);
    part.rearrangePages(group);
    parts.push(saveBytes(part, opts.removePassword));
    part.destroy?.();
  });
  return { bytes: result, stats, parts };
}

/**
 * Estimate the exported size without compression and at each compression
 * preset, cheaply enough to show before the user exports.
 *
 * The uncompressed size is exact (it is a real save). For each preset, the
 * few largest images that would be re-encoded are encoded for real; the rest
 * are assumed to compress to the same bytes per pixel.
 *
 * @param opts  same boxes/keep/rotate/encodeJpeg as processPdf, plus
 *              presets: [{ ppi, quality }]
 * @returns { none, presets: number[] }  sizes in bytes
 */
export async function estimateSizes(mupdf, bytes, opts, progress = () => {}) {
  const doc = prepare(mupdf, bytes, opts, progress);
  bytes = null;
  try {
    progress({ phase: 'scan' });
    const uses = [...collectImageUses(doc).values()];
    const savings = [];
    for (const { ppi = 200, quality = 82 } of opts.presets ?? []) {
      const plans = [];
      for (const u of uses) {
        try { const p = planImage(doc, u, ppi); if (p) plans.push(p); } catch { /* skipped on export too */ }
      }
      plans.sort((a, b) => b.nw * b.nh - a.nw * a.nh);
      let saving = 0, samplePx = 0, sampleBytes = 0, k = 0;
      for (; k < plans.length && k < ESTIMATE_SAMPLES; k++) {
        const p = plans[k];
        let enc = null;
        try { enc = await encodeImage(mupdf, doc, p, quality, opts.encodeJpeg); } catch { /* left as is */ }
        if (!enc) continue;
        samplePx += p.nw * p.nh;
        sampleBytes += enc.jpeg.length;
        if (enc.jpeg.length < p.rawLen * 0.9) saving += p.rawLen - enc.jpeg.length;
      }
      const perPx = samplePx ? sampleBytes / samplePx : 0;
      for (; perPx && k < plans.length; k++) {
        const p = plans[k], est = perPx * p.nw * p.nh;
        if (est < p.rawLen * 0.9) saving += p.rawLen - est;
      }
      savings.push(saving);
    }
    progress({ phase: 'save' });
    const none = saveBytes(doc, opts.removePassword, doc.mergedPassword).length;
    return { none, presets: savings.map((s) => Math.max(0, Math.round(none - s))) };
  } finally {
    doc.destroy?.();
  }
}

const ESTIMATE_SAMPLES = 3;

// Open the PDF and apply crop boxes, rotation and the page subset/order.
function prepare(mupdf, bytes, opts, progress) {
  progress({ phase: 'open' });
  const doc = Array.isArray(bytes) ? openMerged(mupdf, bytes) : openDoc(mupdf, bytes, opts.password);
  bytes = null; // mupdf has its own copy; let the caller's buffer be freed
  const n = doc.countPages();

  opts.boxes?.forEach((b, i) => {
    if (!b || i >= n) return;
    const page = doc.findPage(i);
    page.put('MediaBox', b);
    page.put('CropBox', b);
    for (const k of ['BleedBox', 'TrimBox', 'ArtBox']) page.delete(k);
  });

  if (opts.stamps?.length) addStamps(mupdf, doc, opts.stamps, n);

  // Extra clockwise rotation per source page, added to any /Rotate it has.
  opts.rotate?.forEach((deg, i) => {
    if (!deg || i >= n) return;
    const page = doc.findPage(i);
    const cur = page.getInheritable('Rotate');
    page.put('Rotate', ((((cur.isNumber() ? cur.asNumber() : 0) + deg) % 360) + 360) % 360);
  });

  if (opts.stripMetadata) stripMetadata(doc);

  const keep = opts.keep ?? [...Array(n).keys()];
  if (keep.length === 0) { doc.destroy?.(); throw new Error('No pages selected'); }
  if (keep.length !== n || keep.some((p, i) => p !== i)) {
    progress({ phase: 'pages' });
    doc.rearrangePages(keep);
  }
  return doc;
}

// Open a PDF, unlocking it with the password if it needs one.
function openDoc(mupdf, bytes, password) {
  const doc = new mupdf.PDFDocument(bytes);
  if (doc.needsPassword() && !doc.authenticatePassword(password ?? '')) {
    doc.destroy?.();
    throw Object.assign(new Error(password ? 'Wrong password' : 'This PDF needs a password'), { code: 'password' });
  }
  return doc;
}

// Several PDFs as one document: the first, with every page of the others
// appended. A graft map copies each file's shared fonts and images once.
function openMerged(mupdf, sources) {
  const [first, ...rest] = sources;
  const doc = openDoc(mupdf, first.bytes, first.password);
  for (const s of rest) {
    const src = openDoc(mupdf, s.bytes, s.password);
    const map = doc.newGraftMap();
    for (let i = 0, n = src.countPages(); i < n; i++) map.graftPage(-1, src, i);
    map.destroy?.();
    src.destroy?.();
  }
  if (rest.length) {
    // Appended files bring no protection of their own; if any was protected,
    // protect the whole with the first password given.
    doc.mergedPassword = sources.find((s) => s.password)?.password;
  }
  return doc;
}

// A protected PDF keeps its encryption (original passwords and permissions)
// unless removePassword. A merged one is encrypted with `reencrypt`.
function saveBytes(doc, removePassword = false, reencrypt = undefined) {
  const enc = removePassword ? ',decrypt'
    : reencrypt ? `,encrypt=aes-256,user-password=${pdfOptValue(reencrypt)},owner-password=${pdfOptValue(reencrypt)}` : '';
  const out = doc.saveToBuffer(`garbage=deduplicate,compress=yes${enc}`);
  const result = out.asUint8Array().slice();
  out.destroy?.();
  return result;
}

/**
 * Facts about the PDF that the page shows before export. For now, how many
 * signature fields are signed: a digital signature covers the exact bytes of
 * the file, so any export, which rewrites the file, breaks it.
 */
export function inspectPdf(mupdf, bytes, password) {
  // Several files: inspect each and add up.
  if (Array.isArray(bytes)) {
    return { signed: bytes.reduce((t, src) => t + inspectPdf(mupdf, src.bytes, src.password).signed, 0) };
  }
  const doc = openDoc(mupdf, bytes, password);
  try {
    let signed = 0;
    const seen = new Set();
    const walk = (field, ft, depth) => {
      if (!field.isDictionary() || depth > 20) return;
      if (field.isIndirect()) {
        if (seen.has(field.asIndirect())) return;
        seen.add(field.asIndirect());
      }
      const own = field.get('FT');
      const type = own.isName() ? own.asName() : ft; // /FT is inherited from parents
      const kids = field.get('Kids');
      if (type === 'Sig' && field.get('V').isDictionary()) signed++;
      if (kids.isArray()) for (let k = 0; k < kids.length; k++) walk(kids.get(k), type, depth + 1);
    };
    const form = doc.getTrailer().get('Root').get('AcroForm');
    const fields = form.isDictionary() ? form.get('Fields') : null;
    if (fields?.isArray()) for (let k = 0; k < fields.length; k++) walk(fields.get(k), null, 0);
    return { signed };
  } finally {
    doc.destroy?.();
  }
}

/* ---------- metadata ---------- */

function stripMetadata(doc) {
  // Document info: keep only the title.
  // Emptied in place: mupdf keeps the trailer's original reference to it.
  const info = doc.getTrailer().get('Info');
  if (info.isDictionary()) {
    const keys = [];
    info.forEach((v, k) => { if (k !== 'Title') keys.push(k); });
    for (const k of keys) info.delete(k);
  }
  // XMP metadata and editing programs' private data, wherever they hang:
  // the catalog, pages, images, fonts. Photo metadata inside JPEG images.
  const n = doc.countObjects();
  for (let k = 1; k < n; k++) {
    const obj = doc.newIndirect(k);
    if (!obj.isDictionary() && !obj.isStream()) continue;
    const type = obj.get('Type');
    if (type.isName() && type.asName() === 'Metadata') continue; // the streams themselves go with their references
    obj.delete('Metadata');
    obj.delete('PieceInfo');
    if (obj.isStream() && filterNames(obj.get('Filter')).join() === 'DCTDecode') {
      const raw = obj.readRawStream();
      const jpeg = raw.asUint8Array().slice();
      raw.destroy?.();
      const clean = stripJpegMetadata(jpeg);
      if (clean !== jpeg) {
        obj.writeRawStream(clean);
        obj.put('Length', clean.length);
      }
    }
  }
}

// Remove metadata segments from a JPEG without re-encoding it: EXIF and XMP
// (APP1), Photoshop/IPTC (APP13), other application data and comments. Keeps
// JFIF (APP0), the colour profile (APP2) and Adobe's colour marker (APP14),
// which change how the image looks. Returns the input if nothing changed.
export function stripJpegMetadata(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keepApp = new Set([0xe0, 0xe2, 0xee]);
  const parts = [b.subarray(0, 2)];
  let i = 2, removed = false;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xda) break; // start of scan: the rest is image data
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b; // damaged: leave it alone
    const meta = (m >= 0xe1 && m <= 0xef && !keepApp.has(m)) || m === 0xfe;
    if (meta) removed = true;
    else parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!removed) return b;
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- stamps (signatures) ---------- */

function addStamps(mupdf, doc, stamps, n) {
  const byPage = new Map();
  for (const st of stamps) {
    if (!(st.page >= 0 && st.page < n)) throw new Error(`No page ${st.page + 1} to sign`);
    byPage.set(st.page, [...(byPage.get(st.page) ?? []), st]);
  }
  for (const [i, list] of byPage) {
    const page = doc.findPage(i);
    const rot = page.getInheritable('Rotate');
    const deg = ((((rot.isNumber() ? rot.asNumber() : 0) % 360) + 360) % 360);

    // The page gets its own Resources and XObject dictionaries, so pages
    // that share them (often via the page tree) aren't changed as well.
    const res = doc.newDictionary();
    const inh = page.getInheritable('Resources');
    if (inh.isDictionary()) inh.forEach((v, k) => res.put(k, v));
    const xo = doc.newDictionary();
    const oldXo = res.get('XObject');
    if (oldXo.isDictionary()) oldXo.forEach((v, k) => xo.put(k, v));

    let ops = 'Q\n';
    list.forEach((st, k) => {
      let name = `PaSig${k}`;
      while (xo.get(name).isStream()) name += 'x';
      const image = new mupdf.Image(st.png);
      xo.put(name, doc.addImage(image));
      image.destroy?.();
      ops += `q ${uprightMatrix(st.rect, deg).map(num).join(' ')} cm /${name} Do Q\n`;
    });
    res.put('XObject', xo);
    page.put('Resources', res);

    // Wrap the existing content in q ... Q so whatever graphics state it
    // leaves behind can't move or clip the stamps drawn after it.
    const contents = doc.newArray();
    contents.push(doc.addStream('q\n', {}));
    const old = page.get('Contents');
    if (old.isArray()) old.forEach((v) => contents.push(v));
    else if (old.isStream()) contents.push(old);
    contents.push(doc.addStream(ops, {}));
    page.put('Contents', contents);
  }
}

// Matrix that draws an image's unit square into rect so it looks upright on a
// page displayed with /Rotate deg (clockwise).
export function uprightMatrix([x0, y0, x1, y1], deg) {
  const W = x1 - x0, H = y1 - y0;
  switch (deg) {
    case 90: return [0, H, -W, 0, x1, y0];
    case 180: return [-W, 0, 0, -H, x1, y1];
    case 270: return [0, -H, W, 0, x0, y1];
    default: return [W, 0, 0, H, x0, y0];
  }
}

// mupdf's save options are comma-separated key=value pairs, so a password
// can't contain a comma there.
function pdfOptValue(v) {
  if (/[,=]/.test(v)) throw Object.assign(new Error('A password with a comma or = sign cannot be used to protect a merged file'), { code: 'password-chars' });
  return v;
}

const num = (v) => String(Math.round(v * 1000) / 1000);

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

// Decide whether and how far to shrink an image; null means leave it alone.
function planImage(doc, u, ppi) {
  const obj = u.ref;
  const im = obj.get('ImageMask');
  if (im.isBoolean() && im.asBoolean()) return null;
  const W = obj.get('Width').asNumber(), H = obj.get('Height').asNumber();
  const bpc = obj.get('BitsPerComponent');
  if (bpc.isNumber() && bpc.asNumber() < 8) return null;
  if (W * H < 128 * 128 || u.w <= 0 || u.h <= 0) return null;
  const filters = filterNames(obj.get('Filter'));
  if (filters.some((f) => SKIP_FILTERS.has(f))) return null;
  const rawLen = obj.get('Length').asNumber();
  const isJpeg = filters.includes('DCTDecode');

  // Keep enough pixels for `ppi` at the largest size the image is drawn.
  let scale = Math.min(1, Math.max((u.w / 72) * ppi / W, (u.h / 72) * ppi / H));
  if (scale > 0.85) scale = 1;

  if (scale === 1) {
    // Not worth touching: already JPEG at a sensible size, or lossless data
    // that compresses well (logos, screenshots), which JPEG would only blur.
    if (isJpeg) return null;
    const image = doc.loadImage(obj);
    const nComp = image.getNumberOfComponents();
    image.destroy?.();
    if (rawLen / (W * H * nComp) < 0.3) return null;
  }
  const nw = Math.max(1, Math.round(W * scale)), nh = Math.max(1, Math.round(H * scale));
  return { obj, W, H, scale, nw, nh, rawLen };
}

// Decode, shrink and JPEG-encode a planned image. Null if it has alpha.
async function encodeImage(mupdf, doc, plan, quality, encodeJpeg) {
  const { obj, nw, nh, scale } = plan;
  const image = doc.loadImage(obj);
  let pix = image.toPixmap();
  image.destroy?.();
  if (pix.getAlpha()) { pix.destroy?.(); return null; }

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

  const out = scale === 1 ? pix : resamplePixmap(mupdf, pix, nw, nh);
  let jpeg;
  if (encodeJpeg && out.getNumberOfComponents() === 3) {
    const px = out.getPixels(), stride = out.getStride();
    const rgb = new Uint8Array(nw * nh * 3); // copy out of the wasm heap before awaiting
    for (let y = 0; y < nh; y++) rgb.set(px.subarray(y * stride, y * stride + nw * 3), y * nw * 3);
    if (out !== pix) out.destroy?.();
    pix.destroy?.();
    jpeg = await encodeJpeg(rgb, nw, nh, quality);
  } else {
    jpeg = out.asJPEG(quality, false).slice();
    if (out !== pix) out.destroy?.();
    pix.destroy?.();
  }
  return { jpeg, keepCs };
}

async function rewriteImage(mupdf, doc, u, ppi, quality, encodeJpeg, stats, doneMasks) {
  const obj = u.ref;
  if (doneMasks.has(obj.asIndirect())) return;
  const plan = planImage(doc, u, ppi);
  if (!plan) return;
  const enc = await encodeImage(mupdf, doc, plan, quality, encodeJpeg);
  if (!enc) return;
  const { jpeg, keepCs } = enc;
  const { nw, nh, rawLen, scale } = plan;

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
