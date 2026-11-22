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

// A JPEG photo with real EXIF data: camera, software, date taken and GPS.
// `le` picks the byte order ("II" or "MM"); cameras use both.
export function exifJpeg({ make = 'Apple', model = 'iPhone 15 Pro', software = '17.4', taken = '2026:03:12 14:02:11',
  lat = [32, 4, 48], latRef = 'N', lon = [34, 46, 52], lonRef = 'E', le = true } = {}) {
  // Tags as [tag, type, value]: type 2 ASCII, 4 LONG, 5 RATIONAL (array of numbers).
  const build = (ifds) => {
    // Layout: header, then each IFD followed by its out-of-line data.
    const bytes = [];
    const w16 = (v, at) => { const b = le ? [v & 255, v >> 8] : [v >> 8, v & 255]; if (at == null) bytes.push(...b); else bytes.splice(at, 2, ...b); };
    const w32 = (v, at) => { const b = le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]; if (at == null) bytes.push(...b); else bytes.splice(at, 4, ...b); };
    bytes.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]));
    w16(42); w32(8);
    const offsets = {};
    for (const [name, entries] of ifds) {
      offsets[name] = bytes.length;
      const data = [];
      const dataStart = bytes.length + 2 + entries.length * 12 + 4;
      w16(entries.length);
      for (const [tag, type, value] of entries) {
        w16(tag); w16(type);
        let raw;
        if (type === 2) raw = [...new TextEncoder().encode(value), 0];
        else if (type === 4) raw = null;
        else if (type === 5) raw = value.flatMap((x) => { const t = []; const p = (v) => t.push(...(le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255])); p(Math.round(x * 100)); p(100); return t; });
        w32(type === 5 ? value.length : type === 2 ? raw.length : 1);
        if (type === 4) w32(typeof value === 'string' ? 0 : value); // pointers patched below
        else if (raw.length <= 4) { bytes.push(...raw, ...Array(4 - raw.length).fill(0)); }
        else { w32(dataStart + data.length); data.push(...raw); }
        if (type === 4 && typeof value === 'string') entries.patch = [...(entries.patch ?? []), [bytes.length - 4, value]];
      }
      w32(0);
      bytes.push(...data);
      for (const [at, target] of entries.patch ?? []) offsets[`@${at}`] = target;
    }
    for (const [k, target] of Object.entries(offsets)) if (k.startsWith('@')) w32(offsets[target], Number(k.slice(1)));
    return bytes;
  };
  const tiff = build([
    ['ifd0', [[0x010f, 2, make], [0x0110, 2, model], [0x0131, 2, software], [0x8769, 4, 'exif'], [0x8825, 4, 'gps']]],
    ['exif', [[0x9003, 2, taken]]],
    ['gps', [[1, 2, latRef], [2, 5, lat], [3, 2, lonRef], [4, 5, lon]]],
  ]);
  const body = [...new TextEncoder().encode('Exif\0\0'), ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const jpeg = photoPixmap(320, 240, 9).asJPEG(80, false).slice();
  return Uint8Array.from([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

// A one-page form with a text field, a multi-line text field, a checkbox,
// a pair of radio buttons and a drop-down list, then a page with no fields.
export function formPdf() {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 595, H: 842 }, { W: 595, H: 842 }]));
  const page = doc.findPage(0);
  const helv = doc.addObject(doc.newDictionary());
  helv.put('Type', doc.newName('Font'));
  helv.put('Subtype', doc.newName('Type1'));
  helv.put('BaseFont', doc.newName('Helvetica'));
  const fields = doc.newArray(), annots = doc.newArray();
  const onOff = (on, w, h) => ({
    [on]: doc.addStream(`0 0 0 rg 3 3 ${w - 6} ${h - 6} re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }),
    Off: doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }),
  });
  function widget({ name, ft, rect, ff = 0, parent, set = {} }) {
    const f = doc.addObject(doc.newDictionary());
    f.put('Type', doc.newName('Annot'));
    f.put('Subtype', doc.newName('Widget'));
    f.put('Rect', rect);
    f.put('P', page);
    f.put('F', 4);
    if (parent) f.put('Parent', parent);
    else {
      f.put('FT', doc.newName(ft));
      f.put('T', doc.newString(name));
      f.put('DA', doc.newString('/Helv 11 Tf 0 g'));
      if (ff) f.put('Ff', ff);
      fields.push(f);
    }
    for (const [k, v] of Object.entries(set)) f.put(k, v);
    annots.push(f);
    return f;
  }
  widget({ name: 'name', ft: 'Tx', rect: [72, 742, 372, 764] });
  widget({ name: 'address', ft: 'Tx', rect: [72, 660, 372, 720], ff: 1 << 12 });
  const n = doc.newDictionary();
  for (const [k, v] of Object.entries(onOff('Yes', 16, 16))) n.put(k, v);
  const ap = doc.newDictionary();
  ap.put('N', n);
  widget({ name: 'agree', ft: 'Btn', rect: [72, 620, 88, 636], set: { AP: ap, AS: doc.newName('Off'), V: doc.newName('Off') } });
  const group = doc.addObject(doc.newDictionary());
  group.put('FT', doc.newName('Btn'));
  group.put('T', doc.newString('color'));
  group.put('Ff', (1 << 15) | (1 << 14));
  group.put('V', doc.newName('Off'));
  const kids = doc.newArray();
  ['red', 'blue'].forEach((c, k) => {
    const nk = doc.newDictionary();
    for (const [s, v] of Object.entries(onOff(c, 16, 16))) nk.put(s, v);
    const apk = doc.newDictionary();
    apk.put('N', nk);
    kids.push(widget({ parent: group, rect: [72 + k * 40, 580, 88 + k * 40, 596], set: { AP: apk, AS: doc.newName('Off') } }));
  });
  group.put('Kids', kids);
  fields.push(group);
  const opt = doc.newArray();
  for (const o of ['London', 'Paris', 'תל אביב']) opt.push(doc.newString(o));
  widget({ name: 'city', ft: 'Ch', rect: [72, 530, 272, 552], ff: 1 << 17, set: { Opt: opt } });
  page.put('Annots', annots);
  const form = doc.newDictionary();
  form.put('Fields', fields);
  const dr = doc.newDictionary(), fonts = doc.newDictionary();
  fonts.put('Helv', helv);
  dr.put('Font', fonts);
  form.put('DR', dr);
  form.put('DA', doc.newString('/Helv 0 Tf 0 g'));
  doc.getTrailer().get('Root').put('AcroForm', form);
  return doc.saveToBuffer('').asUint8Array().slice();
}
