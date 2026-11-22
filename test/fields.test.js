import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf } from '../pdf-core.js';
import { mupdf, formPdf } from './fixtures.js';

// A solid red picture, standing in for text the browser draws.
function redPng(w = 60, h = 10) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.clear(0);
  const px = pix.getPixels();
  for (let k = 0; k < px.length; k += 3) px[k] = 255;
  return pix.asPNG().slice();
}

function values(bytes, page = 0) {
  const doc = new mupdf.PDFDocument(bytes);
  const out = {};
  for (const w of doc.loadPage(page).getWidgets()) {
    const name = w.getName();
    out[name] = w.isRadioButton() ? [...(out[name] ?? []), w.getObject().get('AS').toString()] : w.getValue();
  }
  return out;
}

const NAME = [72, 742, 372, 764];

test('fills text, a check box, a radio button and a choice', async () => {
  const { bytes } = await processPdf(mupdf, formPdf(), { fields: [
    { page: 0, name: 'name', rect: NAME, type: 'text', value: 'שלום Ada', png: redPng() },
    { page: 0, name: 'agree', rect: [72, 620, 88, 636], type: 'check', value: 'Yes' },
    { page: 0, name: 'color', rect: [112, 580, 128, 596], type: 'radio', value: 'blue' },
    { page: 0, name: 'city', rect: [72, 530, 272, 552], type: 'choice', value: 'תל אביב', png: redPng() },
  ] });
  const v = values(bytes);
  assert.equal(v.name, 'שלום Ada');
  assert.equal(v.address, ''); // untouched
  assert.equal(v.agree, 'Yes');
  assert.deepEqual(v.color, ['/Off', '/blue']);
  assert.equal(v.city, 'תל אביב');
});

test('text fields show the picture drawn for them, which has every script', async () => {
  const { bytes } = await processPdf(mupdf, formPdf(), { fields: [
    { page: 0, name: 'name', rect: NAME, type: 'text', value: 'שלום', png: redPng() },
  ] });
  const doc = new mupdf.PDFDocument(bytes);
  const w = doc.loadPage(0).getWidgets().find((x) => x.getName() === 'name');
  assert.match(w.getObject().get('AP').get('N').readStream().asString(), /\/Im0 Do/);
  // Red across the field on the rendered page (y counts down from the top).
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels(), s = pix.getStride();
  const at = (x, y) => [...px.subarray(y * s + x * 3, y * s + x * 3 + 3)];
  assert.deepEqual(at(200, 842 - 753), [255, 0, 0]);
  assert.deepEqual(at(200, 842 - 700), [255, 255, 255]); // the address field stays empty
});

test('filled values survive keeping some pages and splitting', async () => {
  const { bytes, parts } = await processPdf(mupdf, formPdf(), {
    keep: [1, 0], split: [[1]],
    fields: [{ page: 0, name: 'name', rect: NAME, type: 'text', value: 'Ada', png: redPng() },
      { page: 0, name: 'agree', rect: [72, 620, 88, 636], type: 'check', value: 'Yes' }],
  });
  assert.equal(values(bytes, 1).name, 'Ada');
  assert.equal(values(parts[0], 0).name, 'Ada');
  assert.equal(values(parts[0], 0).agree, 'Yes');
  const w = new mupdf.PDFDocument(parts[0]).loadPage(0).getWidgets().find((x) => x.getName() === 'name');
  assert.match(w.getObject().get('AP').get('N').readStream().asString(), /\/Im0 Do/);
});

test('a check box can be cleared, and a field that is not there is skipped', async () => {
  const { bytes: once } = await processPdf(mupdf, formPdf(), { fields: [{ page: 0, name: 'agree', rect: [72, 620, 88, 636], type: 'check', value: 'Yes' }] });
  const { bytes } = await processPdf(mupdf, once, { fields: [
    { page: 0, name: 'agree', rect: [72, 620, 88, 636], type: 'check', value: 'Off' },
    { page: 0, name: 'nope', rect: [0, 0, 10, 10], type: 'text', value: 'x' },
  ] });
  assert.equal(values(bytes).agree, 'Off');
});
