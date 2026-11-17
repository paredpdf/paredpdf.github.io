// Builds small PDFs in code for the export-engine tests, so no binary
// fixtures live in the repo.
import * as mupdf from 'mupdf';

export { mupdf };

// Deterministic photo-like RGB pixmap: smooth gradients plus noise, which
// compresses poorly with Flate (like real photos do).
export function photoPixmap(w, h, seed = 1) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(), stride = pix.getStride();
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const noise = (s >> 24) - 64;
      const o = y * stride + x * 3;
      px[o] = (x * 255) / w + noise;
      px[o + 1] = (y * 255) / h + noise;
      px[o + 2] = 128 + noise;
    }
  }
  return pix;
}

/**
 * pages: [{ W, H, draw: [{ image, at: [x, y, width, height], viaForm? }] }]
 * image: { w, h, seed?, jpeg? } or a key into `shared` to reuse one image.
 * Returns the PDF bytes.
 */
export function makePdf(pages, shared = {}) {
  const doc = new mupdf.PDFDocument();
  const refs = {};
  const imageRef = (spec) => {
    if (typeof spec === 'string') return (refs[spec] ??= imageRef(shared[spec]));
    const pix = photoPixmap(spec.w, spec.h, spec.seed ?? 1);
    const img = spec.jpeg ? new mupdf.Image(pix.asJPEG(80, false)) : new mupdf.Image(pix);
    return doc.addImage(img);
  };
  for (const pg of pages) {
    const xobjects = {};
    let content = '';
    (pg.draw ?? []).forEach((d, k) => {
      const ref = imageRef(d.image);
      const [x, y, w, h] = d.at;
      if (d.viaForm) {
        // A form XObject that draws the image in its unit square.
        const form = doc.addStream('q 1 0 0 1 0 0 cm /Im0 Do Q', {
          Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { Im0: ref } },
        });
        xobjects[`Fm${k}`] = form;
        content += `q ${w} 0 0 ${h} ${x} ${y} cm /Fm${k} Do Q\n`;
      } else {
        xobjects[`Im${k}`] = ref;
        content += `q ${w} 0 0 ${h} ${x} ${y} cm /Im${k} Do Q\n`;
      }
    });
    doc.insertPage(-1, doc.addPage([0, 0, pg.W, pg.H], 0, { XObject: xobjects }, content));
  }
  return doc.saveToBuffer('compress=yes').asUint8Array().slice();
}

// Summarise a PDF: page boxes and the image XObjects each page draws.
export function inspect(bytes) {
  const doc = new mupdf.PDFDocument(bytes);
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    const box = (k) => { const b = page.get(k); return b.isArray() ? [0, 1, 2, 3].map((j) => b.get(j).asNumber()) : null; };
    const rot = page.getInheritable('Rotate');
    pages.push({ mediaBox: box('MediaBox'), cropBox: box('CropBox'), trimBox: box('TrimBox'), rotate: rot.isNumber() ? rot.asNumber() : 0 });
  }
  const images = [];
  for (let n = 1; n < doc.countObjects(); n++) {
    const o = doc.newIndirect(n);
    if (!o.isStream() || !o.get('Subtype').isName() || o.get('Subtype').asName() !== 'Image') continue;
    const f = o.get('Filter');
    images.push({
      num: n, w: o.get('Width').asNumber(), h: o.get('Height').asNumber(),
      filter: f.isName() ? f.asName() : f.isArray() ? f.get(0).asName() : null,
      length: o.get('Length').asNumber(),
    });
  }
  return { pages, images };
}
