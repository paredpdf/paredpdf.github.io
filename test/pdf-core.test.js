import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf, estimateSizes, tokenize } from '../pdf-core.js';
import { mupdf, makePdf, inspect } from './fixtures.js';

const A4L = { W: 842, H: 595 };
const SLIDE = [253.656, 0, 588.344, 595];
const run = (bytes, opts) => processPdf(mupdf, bytes, opts);

/* ---------- cropping and page selection ---------- */

test('sets MediaBox and CropBox, and drops the other boxes', async () => {
  const src = makePdf([{ ...A4L }, { ...A4L }]);
  const { bytes, stats } = await run(src, { boxes: [SLIDE, SLIDE] });
  const { pages } = inspect(bytes);
  for (const p of pages) {
    p.mediaBox.forEach((v, i) => assert.ok(Math.abs(v - SLIDE[i]) < 1e-3));
    assert.deepEqual(p.cropBox, p.mediaBox);
    assert.equal(p.trimBox, null);
  }
  assert.equal(stats, null);
});

test('leaves pages without a box untouched', async () => {
  const { bytes } = await run(makePdf([{ ...A4L }, { ...A4L }]), { boxes: [SLIDE, null] });
  assert.deepEqual(inspect(bytes).pages[1].mediaBox, [0, 0, 842, 595]);
});

test('keeps only the selected pages, in the given order', async () => {
  const src = makePdf([{ W: 600, H: 600 }, { W: 700, H: 600 }, { W: 800, H: 600 }]);
  const { bytes } = await run(src, { keep: [2, 0] });
  assert.deepEqual(inspect(bytes).pages.map((p) => p.mediaBox[2]), [800, 600]);
});

test('rotates pages, adding to any rotation they already have', async () => {
  // Page 3 starts rotated 90°.
  const doc = new mupdf.PDFDocument(makePdf([{ ...A4L }, { ...A4L }, { ...A4L }]));
  doc.findPage(2).put('Rotate', 90);
  const src = doc.saveToBuffer('').asUint8Array().slice();
  const { bytes } = await run(src, { rotate: [90, 0, 270] });
  assert.deepEqual(inspect(bytes).pages.map((p) => p.rotate), [90, 0, 0]);
});

test('rotation follows the page when pages are reordered', async () => {
  const src = makePdf([{ W: 600, H: 600 }, { W: 700, H: 600 }]);
  const { bytes } = await run(src, { keep: [1, 0], rotate: [0, 180] });
  assert.deepEqual(inspect(bytes).pages.map((p) => [p.mediaBox[2], p.rotate]), [[700, 180], [600, 0]]);
});

test('refuses to export zero pages', async () => {
  await assert.rejects(run(makePdf([{ ...A4L }]), { keep: [] }), /No pages selected/);
});

test('removes images that only skipped pages used', async () => {
  const src = makePdf([
    { ...A4L, draw: [{ image: { w: 300, h: 200, seed: 1 }, at: [0, 0, 300, 200] }] },
    { ...A4L, draw: [{ image: { w: 300, h: 200, seed: 2 }, at: [0, 0, 300, 200] }] },
  ]);
  assert.equal(inspect(src).images.length, 2);
  const { bytes } = await run(src, { keep: [0] });
  assert.equal(inspect(bytes).images.length, 1);
});

/* ---------- image compression ---------- */

test('downsamples a large image to the target ppi and saves it as JPEG', async () => {
  // 2000×1000 px drawn at 300×150 pt is 480 ppi; at 150 ppi it should be 625×313.
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 2000, h: 1000 }, at: [100, 100, 300, 150] }] }]);
  const { bytes, stats } = await run(src, { compress: { ppi: 150, quality: 75 } });
  const [img] = inspect(bytes).images;
  assert.equal(img.filter, 'DCTDecode');
  assert.deepEqual([img.w, img.h], [625, 313]);
  assert.equal(stats.rewritten, 1);
  assert.ok(stats.after < stats.before / 5, `expected a big saving, got ${stats.before} -> ${stats.after}`);
  assert.ok(bytes.length < src.length / 5);
});

test('sizes a shared image for the largest place it is drawn', async () => {
  const shared = { photo: { w: 2000, h: 1000 } };
  // Large use first, so "last size wins" would get it wrong.
  const src = makePdf([
    { ...A4L, draw: [{ image: 'photo', at: [0, 0, 400, 200] }] },
    { ...A4L, draw: [{ image: 'photo', at: [0, 0, 100, 50] }] },
  ], shared);
  assert.equal(inspect(src).images.length, 1);
  const { bytes } = await run(src, { compress: { ppi: 150, quality: 75 } });
  // 400 pt wide at 150 ppi = 833 px.
  assert.equal(inspect(bytes).images[0].w, 833);
});

test('finds images drawn inside form XObjects', async () => {
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 2000, h: 1000 }, at: [0, 0, 300, 150], viaForm: true }] }]);
  const { bytes, stats } = await run(src, { compress: { ppi: 150, quality: 75 } });
  assert.equal(stats.images, 1);
  assert.deepEqual([inspect(bytes).images[0].w, inspect(bytes).images[0].h], [625, 313]);
});

test('leaves small images alone', async () => {
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 100, h: 100 }, at: [0, 0, 10, 10] }] }]);
  const before = inspect(src).images[0];
  const { bytes, stats } = await run(src, { compress: { ppi: 150, quality: 75 } });
  assert.equal(stats.rewritten, 0);
  assert.deepEqual(inspect(bytes).images[0].w, before.w);
});

test('leaves JPEGs that are already near the target resolution alone', async () => {
  // 600 px over 300 pt is 144 ppi, close enough to 150 that it isn't worth re-encoding.
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 600, h: 300, jpeg: true }, at: [0, 0, 300, 150] }] }]);
  const before = inspect(src).images[0];
  const { bytes, stats } = await run(src, { compress: { ppi: 150, quality: 75 } });
  assert.equal(stats.rewritten, 0);
  assert.deepEqual(inspect(bytes).images[0], before);
});

test('re-encodes a lossless photo as JPEG even when no downsampling is needed', async () => {
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 600, h: 300 }, at: [0, 0, 300, 150] }] }]);
  assert.equal(inspect(src).images[0].filter, 'FlateDecode');
  const { bytes } = await run(src, { compress: { ppi: 150, quality: 75 } });
  const img = inspect(bytes).images[0];
  assert.deepEqual([img.filter, img.w, img.h], ['DCTDecode', 600, 300]);
});

test('uses the supplied JPEG encoder for RGB images', async () => {
  const calls = [];
  const encodeJpeg = async (rgb, w, h, quality) => {
    calls.push({ w, h, quality, bytes: rgb.length });
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    pix.getPixels().set(rgb);
    return pix.asJPEG(quality, false).slice();
  };
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 2000, h: 1000 }, at: [0, 0, 300, 150] }] }]);
  await processPdf(mupdf, src, { compress: { ppi: 150, quality: 70 }, encodeJpeg });
  assert.deepEqual(calls, [{ w: 625, h: 313, quality: 70, bytes: 625 * 313 * 3 }]);
});

/* ---------- size estimate ---------- */

// Eight photos of different sizes over four pages, so the estimate has to
// extrapolate from its samples; plus one small image it must leave alone.
function photoBook() {
  const pages = [];
  for (let p = 0; p < 4; p++) {
    pages.push({ ...A4L, draw: [
      { image: { w: 1200 + 200 * p, h: 800 + 100 * p, seed: 2 * p + 1 }, at: [20, 20, 380, 250] },
      { image: { w: 900, h: 900 - 100 * p, seed: 2 * p + 2 }, at: [420, 20, 300, 260] },
      ...(p === 0 ? [{ image: { w: 120, h: 120, seed: 99 }, at: [20, 400, 40, 40] }] : []),
    ] });
  }
  return makePdf(pages);
}

test('estimates the uncompressed size exactly', async () => {
  const src = photoBook();
  const opts = { boxes: [SLIDE, null, SLIDE, null], keep: [3, 0, 2], rotate: [90, 0, 0, 0] };
  const est = await estimateSizes(mupdf, src, { ...opts, presets: [] });
  const { bytes } = await run(src, opts);
  assert.equal(est.none, bytes.length);
});

test('estimates compressed sizes close to the real export', async () => {
  const src = photoBook();
  const presets = [{ ppi: 150, quality: 72 }, { ppi: 200, quality: 78 }, { ppi: 300, quality: 85 }];
  const keep = [0, 1, 2, 3];
  const est = await estimateSizes(mupdf, src, { keep, presets });
  for (let i = 0; i < presets.length; i++) {
    const { bytes } = await run(src, { keep, compress: presets[i] });
    const err = Math.abs(est.presets[i] - bytes.length) / bytes.length;
    assert.ok(err < 0.25, `${presets[i].ppi} ppi: estimated ${est.presets[i]}, actual ${bytes.length}`);
    assert.ok(est.presets[i] < est.none);
  }
  assert.ok(est.presets[0] <= est.presets[1] && est.presets[1] <= est.presets[2]);
});

test('estimates no saving when nothing would be re-encoded', async () => {
  const src = makePdf([{ ...A4L, draw: [{ image: { w: 600, h: 300, jpeg: true }, at: [0, 0, 300, 150] }] }]);
  const est = await estimateSizes(mupdf, src, { presets: [{ ppi: 150, quality: 75 }] });
  assert.equal(est.presets[0], est.none);
});

/* ---------- content-stream tokenizer ---------- */

function ops(src) {
  const out = [];
  tokenize(new TextEncoder().encode(src), (op, args) => out.push([op, ...args]));
  return out;
}

test('tokenize reports operators with numeric and name operands', () => {
  assert.deepEqual(ops('q 1 0 0 1 -2.5 .5 cm /Im0 Do Q'), [
    ['q'], ['cm', 1, 0, 0, 1, -2.5, 0.5], ['Do', { name: 'Im0' }], ['Q'],
  ]);
});

test('tokenize decodes #xx escapes in names', () => {
  assert.deepEqual(ops('/A#20B Do'), [['Do', { name: 'A B' }]]);
});

test('tokenize skips strings, including nested and escaped parentheses', () => {
  assert.deepEqual(ops('BT (a (b) \\) cm Do) Tj <414243> Tj ET'), [['BT'], ['Tj', null], ['Tj', null], ['ET']]);
});

test('tokenize skips inline image data', () => {
  const src = 'BI /W 2 /H 1 /BPC 8 /CS /G ID \u0000Do Qÿ EI q /Im1 Do Q';
  assert.deepEqual(ops(src), [['BI'], ['q'], ['Do', { name: 'Im1' }], ['Q']]);
});

test('tokenize ignores comments', () => {
  assert.deepEqual(ops('% q cm Do\nQ'), [['Q']]);
});
