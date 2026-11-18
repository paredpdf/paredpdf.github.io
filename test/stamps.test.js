import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf } from '../pdf-core.js';
import { mupdf, makePdf } from './fixtures.js';

// A 60×40 test signature: red top half, blue bottom half, and a transparent
// stripe down the right quarter. Its orientation is unambiguous.
function testPng() {
  const w = 60, h = 40;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], true);
  const px = pix.getPixels(), stride = pix.getStride();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + x * 4;
      const clear = x >= w * 0.75;
      px.set(clear ? [0, 0, 0, 0] : y < h / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], o);
    }
  }
  return pix.asPNG().slice();
}

// Render page i as shown (rotation applied) and find where each colour is.
function look(bytes, i = 0) {
  const doc = new mupdf.PDFDocument(bytes);
  const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), s = pix.getStride(), px = pix.getPixels();
  const acc = { red: [0, 0, 0], blue: [0, 0, 0] };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px.subarray(y * s + x * n, y * s + x * n + 3);
      const c = r > 200 && g < 60 && b < 60 ? 'red' : b > 200 && r < 60 && g < 60 ? 'blue' : null;
      if (c) { acc[c][0] += x; acc[c][1] += y; acc[c][2]++; }
    }
  }
  const at = (c) => (acc[c][2] ? { x: acc[c][0] / acc[c][2], y: acc[c][1] / acc[c][2], count: acc[c][2] } : null);
  return { w, h, red: at('red'), blue: at('blue') };
}

const PNG = testPng();

for (const deg of [0, 90, 180, 270]) {
  test(`draws the signature upright on a page rotated ${deg}°`, async () => {
    const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
    if (deg) doc.findPage(0).put('Rotate', deg);
    const src = doc.saveToBuffer('').asUint8Array().slice();
    // A 120×80 pt box; rotated pages show it as 80 wide, 120 tall unless the
    // rect is given in that shape, so give it in the shape it is shown.
    const rect = deg % 180 ? [200, 100, 280, 220] : [200, 100, 320, 180];
    const { bytes } = await processPdf(mupdf, src, { stamps: [{ page: 0, rect, png: PNG }] });
    const { red, blue } = look(bytes);
    assert.ok(red && blue, 'signature not drawn');
    assert.ok(red.y < blue.y - 10, `red should be above blue: ${JSON.stringify({ red, blue })}`);
    assert.ok(Math.abs(red.x - blue.x) < 2, 'halves should line up');
    // Colour fills the left three quarters: 120×80 × 0.75 ≈ 7200 px at 72 dpi.
    assert.ok(Math.abs(red.count + blue.count - 7200) < 400, `area ${red.count + blue.count}`);
  });
}

test('places the signature where asked', async () => {
  const src = makePdf([{ W: 600, H: 400 }]);
  const { bytes } = await processPdf(mupdf, src, { stamps: [{ page: 0, rect: [100, 100, 220, 180], png: PNG }] });
  const { red, blue } = look(bytes);
  // Coloured part spans x 100..190, y (from the top) 220..300.
  assert.ok(Math.abs(red.x - 145) < 2 && Math.abs(blue.x - 145) < 2, `x ${red.x}`);
  assert.ok(Math.abs(red.y - 240) < 2 && Math.abs(blue.y - 280) < 2, `y ${red.y} ${blue.y}`);
});

test('content that leaves a transform behind cannot move the signature', async () => {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
  const page = doc.findPage(0);
  // Scales everything after it by 2 and never restores.
  page.put('Contents', doc.addStream('2 0 0 2 0 0 cm 0 1 0 rg 0 0 1 1 re f', {}));
  const src = doc.saveToBuffer('').asUint8Array().slice();
  const { bytes } = await processPdf(mupdf, src, { stamps: [{ page: 0, rect: [100, 100, 220, 180], png: PNG }] });
  assert.ok(Math.abs(look(bytes).red.x - 145) < 2);
  // mupdf forgives an unmatched Q, other viewers don't: check the wrapping itself.
  const contents = new mupdf.PDFDocument(bytes).findPage(0).get('Contents');
  const streams = Array.from({ length: contents.length }, (_, k) => contents.get(k).readStream().asString().trim());
  assert.equal(streams[0], 'q');
  assert.match(streams.at(-1), /^Q\n/);
});

test('signs only the given page, even when pages share their resources', async () => {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }, { W: 600, H: 400 }]));
  const shared = doc.addObject(doc.newDictionary());
  shared.put('XObject', doc.newDictionary());
  doc.findPage(0).put('Resources', shared);
  doc.findPage(1).put('Resources', shared);
  const src = doc.saveToBuffer('').asUint8Array().slice();
  const { bytes } = await processPdf(mupdf, src, { stamps: [{ page: 1, rect: [100, 100, 220, 180], png: PNG }] });
  assert.equal(look(bytes, 0).red, null);
  assert.ok(look(bytes, 1).red);
});

test('signature pages follow reordering, and stay upright on a page turned in Pared', async () => {
  const src = makePdf([{ W: 600, H: 400 }, { W: 600, H: 400 }]);
  const { bytes } = await processPdf(mupdf, src, {
    keep: [1, 0], rotate: [0, 90], stamps: [{ page: 1, rect: [100, 100, 220, 180], png: PNG }],
  });
  const first = look(bytes, 0); // source page 2, turned 90° clockwise
  assert.ok(first.red && look(bytes, 1).red === null);
  // Placed on the turned page, so upright on it: red still above blue.
  assert.ok(first.red.y < first.blue.y - 10, JSON.stringify(first));
  assert.ok(Math.abs(first.red.x - first.blue.x) < 2);
});

test('several signatures on one page, and compression leaves them sharp', async () => {
  const src = makePdf([{ W: 600, H: 400 }]);
  const { bytes } = await processPdf(mupdf, src, {
    compress: { ppi: 150, quality: 72 },
    stamps: [{ page: 0, rect: [50, 50, 170, 130], png: PNG }, { page: 0, rect: [350, 250, 470, 330], png: PNG }],
  });
  const { red } = look(bytes);
  assert.ok(Math.abs(red.count - 2 * 3600) < 400, `red area ${red.count}`);
});

test('refuses a signature on a page that does not exist', async () => {
  await assert.rejects(processPdf(mupdf, makePdf([{ W: 600, H: 400 }]), { stamps: [{ page: 3, rect: [0, 0, 10, 10], png: PNG }] }), /No page 4/);
});

test('upright for a page with its own rotation plus one added in Pared', async () => {
  const doc = new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }]));
  doc.findPage(0).put('Rotate', 90);
  const src = doc.saveToBuffer('').asUint8Array().slice();
  const { bytes } = await processPdf(mupdf, src, { rotate: [90], stamps: [{ page: 0, rect: [200, 100, 320, 180], png: PNG }] });
  const { red, blue } = look(bytes);
  assert.ok(red.y < blue.y - 10 && Math.abs(red.x - blue.x) < 2, JSON.stringify({ red, blue }));
});
