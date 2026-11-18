import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf, stripJpegMetadata } from '../pdf-core.js';
import { mupdf, makePdf, photoPixmap } from './fixtures.js';

const enc = (s) => new TextEncoder().encode(s);
const seg = (marker, body) => { const b = enc(body); return [0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 255, ...b]; };

// A real JPEG with metadata segments added after the start marker.
function jpegWithMetadata() {
  const jpeg = photoPixmap(400, 300, 3).asJPEG(80, false).slice();
  const extra = [
    ...seg(0xe1, 'Exif\0\0GPS-SECRET 32.08N 34.78E'),
    ...seg(0xed, 'Photoshop 3.0\0IPTC-SECRET'),
    ...seg(0xfe, 'COMMENT-SECRET'),
  ];
  return Uint8Array.from([...jpeg.subarray(0, 2), ...extra, ...jpeg.subarray(2)]);
}

// A PDF carrying every kind of metadata the export should remove.
function leakyPdf() {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
  const info = doc.addObject(doc.newDictionary());
  info.put('Title', doc.newString('Quarterly report'));
  info.put('Author', doc.newString('AUTHOR-SECRET'));
  info.put('Creator', doc.newString('Keynote'));
  info.put('Producer', doc.newString('macOS Quartz PDFContext'));
  info.put('CreationDate', doc.newString('D:20260101120000Z'));
  info.put('X-Custom', doc.newString('CUSTOM-SECRET'));
  doc.getTrailer().put('Info', info);
  const xmp = (s) => doc.addStream(`<x:xmpmeta>${s}</x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' });
  doc.getTrailer().get('Root').put('Metadata', xmp('XMP-SECRET'));
  const page = doc.findPage(0);
  page.put('PieceInfo', doc.addObject(doc.newDictionary()));
  page.get('PieceInfo').put('Illustrator', doc.newString('PIECE-SECRET'));
  const img = doc.addImage(new mupdf.Image(jpegWithMetadata()));
  img.put('Metadata', xmp('IMAGE-XMP-SECRET'));
  page.put('Resources', doc.newDictionary());
  page.get('Resources').put('XObject', doc.newDictionary());
  page.get('Resources').get('XObject').put('Im0', img);
  page.put('Contents', doc.addStream('q 300 0 0 225 0 0 cm /Im0 Do Q', {}));
  return doc.saveToBuffer('').asUint8Array().slice();
}

// Every string in the file, with streams decompressed.
function allText(bytes) {
  const doc = new mupdf.PDFDocument(bytes);
  let text = '';
  for (let k = 1; k < doc.countObjects(); k++) {
    const o = doc.newIndirect(k);
    text += o.resolve().toString() + '\n';
    if (o.isStream()) {
      const raw = o.readRawStream().asUint8Array();
      text += new TextDecoder('latin1').decode(raw) + '\n';
      try { text += o.readStream().asString() + '\n'; } catch { /* binary */ }
    }
  }
  return { doc, text: text + doc.getTrailer().toString() };
}

test('the fixture really does carry every secret', () => {
  const { text } = allText(leakyPdf());
  for (const s of ['AUTHOR-SECRET', 'CUSTOM-SECRET', 'XMP-SECRET', 'IMAGE-XMP-SECRET', 'PIECE-SECRET', 'GPS-SECRET', 'IPTC-SECRET', 'COMMENT-SECRET', 'Keynote']) {
    assert.ok(text.includes(s), `fixture lacks ${s}`);
  }
});

test('removes author, software, dates, XMP, private data and photo metadata', async () => {
  const { bytes } = await processPdf(mupdf, leakyPdf(), { stripMetadata: true });
  const { doc, text } = allText(bytes);
  for (const s of ['AUTHOR-SECRET', 'CUSTOM-SECRET', 'XMP-SECRET', 'IMAGE-XMP-SECRET', 'PIECE-SECRET', 'GPS-SECRET', 'IPTC-SECRET', 'COMMENT-SECRET', 'Keynote', 'Quartz', '20260101']) {
    assert.ok(!text.includes(s), `${s} survived`);
  }
  // The title stays, and the photo still decodes at its full size.
  assert.equal(doc.getTrailer().get('Info').get('Title').asString(), 'Quarterly report');
  const img = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  assert.ok(img.getWidth() > 0);
  const im = doc.findPage(0).get('Resources').get('XObject').get('Im0');
  assert.equal(new mupdf.PDFDocument(bytes).loadImage(im).getWidth(), 400);
});

test('keeps everything when not asked to remove it', async () => {
  const { bytes } = await processPdf(mupdf, leakyPdf(), {});
  const { text } = allText(bytes);
  assert.ok(text.includes('AUTHOR-SECRET') && text.includes('GPS-SECRET'));
});

test('leaves an empty info dictionary when there is no title', async () => {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
  const info = doc.addObject(doc.newDictionary());
  info.put('Author', doc.newString('someone'));
  doc.getTrailer().put('Info', info);
  const { bytes } = await processPdf(mupdf, doc.saveToBuffer('').asUint8Array().slice(), { stripMetadata: true });
  const out = new mupdf.PDFDocument(bytes).getTrailer().get('Info');
  assert.ok(!out.isDictionary() || out.toString() === '<<>>' || !out.resolve().get('Author').isString(), out.resolve().toString());
});

test('JPEG cleaning keeps the segments that change how the image looks', () => {
  const soi = [0xff, 0xd8], sos = [0xff, 0xda, 0, 4, 1, 2, 0xab, 0xcd, 0xff, 0xd9];
  const jfif = seg(0xe0, 'JFIF\0'), icc = seg(0xe2, 'ICC_PROFILE\0'), adobe = seg(0xee, 'Adobe');
  const dqt = [0xff, 0xdb, 0, 3, 7];
  const src = Uint8Array.from([...soi, ...jfif, ...seg(0xe1, 'Exif\0\0x'), ...icc, ...seg(0xfe, 'c'), ...adobe, ...dqt, ...sos]);
  assert.deepEqual([...stripJpegMetadata(src)], [...soi, ...jfif, ...icc, ...adobe, ...dqt, ...sos]);
  // Nothing to remove: the very same array comes back.
  const clean = Uint8Array.from([...soi, ...jfif, ...dqt, ...sos]);
  assert.equal(stripJpegMetadata(clean), clean);
  // Not a JPEG, or damaged: left alone.
  const bad = Uint8Array.from([...soi, 0xff, 0xe1, 0xff, 0xff, 1]);
  assert.equal(stripJpegMetadata(bad), bad);
});
