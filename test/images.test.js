import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegsToPdf, pageSize, isImageFile, isPdfFile } from '../images.js';
import { mupdf, photoPixmap } from './fixtures.js';

const jpeg = (w, h) => photoPixmap(w, h, 3).asJPEG(80, false).slice();

test('each JPEG becomes a page of its own shape, the long side A4', () => {
  const bytes = jpegsToPdf([{ jpeg: jpeg(300, 400), w: 300, h: 400 }, { jpeg: jpeg(400, 200), w: 400, h: 200 }]);
  const doc = new mupdf.PDFDocument(bytes);
  assert.equal(doc.countPages(), 2);
  const box = (i) => { const b = doc.findPage(i).get('MediaBox'); return [0, 1, 2, 3].map((k) => b.get(k).asNumber()); };
  assert.deepEqual(box(0), [0, 0, 631.5, 842]);
  assert.deepEqual(box(1), [0, 0, 842, 421]);
  // The image is stored as it was, not re-encoded, and fills the page.
  const im = doc.findPage(0).get('Resources').get('XObject').get('Im0');
  assert.equal(im.get('Filter').toString(), '/DCTDecode');
  assert.equal(im.readRawStream().asUint8Array().length, jpeg(300, 400).length);
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  assert.equal(pix.getWidth(), 632);
});

test('the PDF is well formed: mupdf reads it without repairing', () => {
  const bytes = jpegsToPdf([{ jpeg: jpeg(50, 50), w: 50, h: 50 }]);
  const doc = new mupdf.PDFDocument(bytes);
  assert.equal(doc.wasRepaired?.() ?? false, false);
  const text = new TextDecoder('latin1').decode(bytes);
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  for (const m of text.matchAll(/(\d{10}) 00000 n/g)) assert.match(text.slice(Number(m[1])), /^\d+ 0 obj/);
});

test('page sizes and file kinds', () => {
  assert.deepEqual(pageSize(4000, 3000), [842, 631.5]);
  assert.equal(isImageFile({ name: 'IMG_1.HEIC', type: '' }), true);
  assert.equal(isImageFile({ name: 'a', type: 'image/jpeg' }), true);
  assert.equal(isImageFile({ name: 'a.pdf', type: 'application/pdf' }), false);
  assert.equal(isPdfFile({ name: 'scan.PDF', type: '' }), true);
});
