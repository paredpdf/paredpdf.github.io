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

// A PDF with `n` signed signature fields, shaped like a real signer's output
// (the bytes aren't a valid signature; detection doesn't check). `unsigned`
// adds empty signature fields; `nested` puts the fields under a parent field
// that holds their /FT, as some form tools do.
export function signedPdf(n = 1, { unsigned = 0, nested = false } = {}) {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 595, H: 842 }]));
  const page = doc.findPage(0);
  const fields = doc.newArray();
  const annots = doc.newArray();
  const parent = nested ? doc.addObject(doc.newDictionary()) : null;
  for (let k = 0; k < n + unsigned; k++) {
    const field = doc.addObject(doc.newDictionary());
    field.put('Type', doc.newName('Annot'));
    field.put('Subtype', doc.newName('Widget'));
    if (!nested) field.put('FT', doc.newName('Sig'));
    field.put('T', doc.newString(`Signature${k + 1}`));
    field.put('Rect', [0, 0, 0, 0]);
    field.put('P', page);
    if (k < n) {
      const sig = doc.addObject(doc.newDictionary());
      sig.put('Type', doc.newName('Sig'));
      sig.put('Filter', doc.newName('Adobe.PPKLite'));
      sig.put('SubFilter', doc.newName('adbe.pkcs7.detached'));
      sig.put('ByteRange', [0, 1000, 9000, 500]);
      sig.put('Contents', doc.newByteString(new Uint8Array(64)));
      field.put('V', sig);
    }
    if (parent) field.put('Parent', parent);
    (parent ? (parent.get('Kids').isArray() ? parent.get('Kids') : (parent.put('Kids', doc.newArray()), parent.get('Kids'))) : fields).push(field);
    annots.push(field);
  }
  if (parent) {
    parent.put('T', doc.newString('Signatures'));
    parent.put('FT', doc.newName('Sig'));
    fields.push(parent);
  }
  page.put('Annots', annots);
  const form = doc.newDictionary();
  form.put('Fields', fields);
  form.put('SigFlags', 3);
  doc.getTrailer().get('Root').put('AcroForm', form);
  // Compress everything we can, so the signature dictionaries end up inside
  // compressed object streams.
  return doc.saveToBuffer('compress=yes,garbage=yes,objstms=yes').asUint8Array().slice();
}
