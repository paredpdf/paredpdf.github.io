// Photos and other images to PDF pages, in the browser. Each image becomes
// one page of its own shape, about A4 in size (its long side 842 pt), so
// photos of documents print at about the size of the paper.
//
// Images are decoded by the browser, which turns each photo upright as the
// camera recorded it, and encoded again as JPEG. That also leaves out the
// photo's metadata (camera, time, location).

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|bmp|avif|heic|heif)$/;
const IMAGE_NAMES = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;

export const isImageFile = (f) => IMAGE_TYPES.test(f.type) || IMAGE_NAMES.test(f.name);
export const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

export const PAGE_LONG = 842;  // points: the long side of A4
const MAX_SIDE = 4000;          // pixels: larger photos are scaled down
const QUALITY = 0.9;

// Decode an image file and encode it as a JPEG, upright, on white (a
// transparent PNG would otherwise turn black).
export async function imageToJpeg(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw Object.assign(new Error(`Can't read the image ${file.name}`), { code: 'image', name: file.name });
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), w, h };
}

// The page size, in points, for an image of w×h pixels.
export function pageSize(w, h) {
  const k = PAGE_LONG / Math.max(w, h);
  return [Math.round(w * k * 100) / 100, Math.round(h * k * 100) / 100];
}

// A PDF with one page per JPEG, each filled by its image. Written by hand:
// a JPEG goes into a PDF as it is, so no PDF engine is needed.
export function jpegsToPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [], offsets = [];
  let length = 0;
  const put = (part) => { const b = typeof part === 'string' ? enc.encode(part) : part; chunks.push(b); length += b.length; };
  const obj = (n, body, stream) => {
    offsets[n] = length;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.7\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach(({ jpeg, w, h }, i) => {
    const [pw, ph] = pageSize(w, h);
    const n = 3 + i * 3;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = enc.encode(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`);
    obj(n + 1, `<< /Length ${content.length} >>`, content);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Turn each run of images among the files into one PDF, in place, so the
// pages keep the order the files came in. PDFs pass through; anything else
// is left out. onImage(done, total) reports progress.
export async function imagesToPdfs(files, onImage = () => {}) {
  const total = files.filter(isImageFile).length;
  const out = [];
  let run = [], done = 0;
  const flush = () => {
    if (!run.length) return;
    const name = `${run[0].name.replace(/\.[^.]+$/, '')}.pdf`;
    out.push(new File([jpegsToPdf(run.map((r) => r.page))], name, { type: 'application/pdf' }));
    run = [];
  };
  for (const f of files) {
    if (isPdfFile(f)) { flush(); out.push(f); continue; }
    if (!isImageFile(f)) continue;
    onImage(done, total);
    run.push({ name: f.name, page: await imageToJpeg(f) });
    onImage(++done, total);
  }
  flush();
  return out;
}
