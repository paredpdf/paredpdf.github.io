import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExif, inspectPdf, processPdf } from '../pdf-core.js';
import { mupdf, makePdf, exifJpeg } from './fixtures.js';

const near = (a, b) => Math.abs(a - b) < 1e-4;

for (const le of [true, false]) {
  test(`reads camera, software, time and GPS (${le ? 'little' : 'big'}-endian)`, () => {
    const e = parseExif(exifJpeg({ le }));
    assert.equal(e.camera, 'Apple iPhone 15 Pro');
    assert.equal(e.software, '17.4');
    assert.equal(e.taken, '2026:03:12 14:02:11');
    assert.ok(near(e.lat, 32 + 4 / 60 + 48 / 3600), e.lat);
    assert.ok(near(e.lon, 34 + 46 / 60 + 52 / 3600), e.lon);
  });
}

test('south and west are negative, and repeated makes are folded', () => {
  const e = parseExif(exifJpeg({ make: 'Canon', model: 'Canon EOS R5', latRef: 'S', lonRef: 'W' }));
  assert.equal(e.camera, 'Canon EOS R5');
  assert.ok(e.lat < 0 && e.lon < 0);
});

test('nothing to report for plain or broken JPEGs', () => {
  const plain = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false).asJPEG(80, false).slice();
  assert.equal(parseExif(plain), null);
  assert.equal(parseExif(new TextEncoder().encode('not a jpeg')), null);
  const bad = exifJpeg();
  bad.fill(0xff, 30, 60); // scribble over the TIFF header
  assert.doesNotThrow(() => parseExif(bad));
});

function pdfWithPhoto() {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
  const page = doc.findPage(0);
  const img = doc.addImage(new mupdf.Image(exifJpeg()));
  page.put('Resources', doc.newDictionary());
  page.get('Resources').put('XObject', doc.newDictionary());
  page.get('Resources').get('XObject').put('Im0', img);
  page.put('Contents', doc.addStream('q 300 0 0 225 0 0 cm /Im0 Do Q', {}));
  const piece = doc.newDictionary();
  piece.put('Illustrator', doc.newDictionary());
  page.put('PieceInfo', piece);
  return doc.saveToBuffer('').asUint8Array().slice();
}

test('inspectPdf reports photo details and editing programs', () => {
  const r = inspectPdf(mupdf, pdfWithPhoto());
  assert.equal(r.photos.length, 1);
  assert.equal(r.photos[0].camera, 'Apple iPhone 15 Pro');
  assert.deepEqual(r.apps, ['Illustrator']);
  const two = inspectPdf(mupdf, [{ bytes: makePdf([{ W: 100, H: 100 }]) }, { bytes: pdfWithPhoto() }]);
  assert.equal(two.photos[0].file, 1);
  assert.deepEqual(two.apps, [{ name: 'Illustrator', file: 1 }]);
});

test('after removing hidden details, there is nothing left to report', async () => {
  const { bytes } = await processPdf(mupdf, pdfWithPhoto(), { stripMetadata: true });
  assert.deepEqual(inspectPdf(mupdf, bytes), { signed: 0, photos: [], apps: [] });
});
