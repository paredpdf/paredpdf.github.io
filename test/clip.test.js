import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pageClipRects, clipPageBox } from '../detect.js';
import { mupdf } from './fixtures.js';

const { OPS } = pdfjs;
const W = 842, H = 595;
const SLIDE = [253.6562, 0, 588.3437, 595];
const norm = ([x0, y0, x1, y1]) => ({ x0: x0 / W, y0: 1 - y1 / H, x1: x1 / W, y1: 1 - y0 / H });
const closeRect = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-3, `${a} ≉ ${b}`));

// Real operator lists: build a PDF page with mupdf, read it back with pdf.js.
async function opsFor(content) {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, {}, content));
  const bytes = doc.saveToBuffer('').asUint8Array().slice();
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const list = await (await pdf.getPage(1)).getOperatorList();
  await pdf.destroy();
  return pageClipRects(list.fnArray, list.argsArray, OPS);
}

test('reads a Keynote-style slide clip', async () => {
  const rects = await opsFor('q 253.6562 0 334.6875 595 re W n 1 1 1 rg 253.6562 0 334.6875 595 re f Q');
  assert.equal(rects.length, 1);
  closeRect(rects[0], SLIDE);
});

test('applies transforms to the clip', async () => {
  const rects = await opsFor('q 1 0 0 1 100 50 cm 0 0 200 300 re W n 0 g 0 0 10 10 re f Q');
  closeRect(rects[0], [100, 50, 300, 350]);
});

test('keeps clips inside save/restore from leaking their transforms', async () => {
  const rects = await opsFor('q 2 0 0 2 0 0 cm Q 10 10 100 100 re W n 0 g 20 20 5 5 re f');
  closeRect(rects[0], [10, 10, 110, 110]);
});

test('ignores clips that are not plain rectangles', async () => {
  const rects = await opsFor('q 0 0 m 100 0 l 50 80 l h W n 0 g 10 10 5 5 re f Q');
  assert.deepEqual(rects, []);
});

test('ignores rectangles that are filled rather than clipped', async () => {
  assert.deepEqual(await opsFor('0 g 100 100 200 200 re f'), []);
});

test('handles a 90° rotation and rejects skewed clips', () => {
  const rotated = pageClipRects(
    [OPS.transform, OPS.constructPath, OPS.clip, OPS.endPath],
    [[0, 1, -1, 0, 595, 0], [[OPS.rectangle], [0, 0, 100, 200], null], null, null],
    OPS,
  );
  closeRect(rotated[0], [395, 0, 595, 100]);
  const skewed = pageClipRects(
    [OPS.transform, OPS.constructPath, OPS.clip],
    [[1, 0.3, 0, 1, 0, 0], [[OPS.rectangle], [0, 0, 100, 200], null], null],
    OPS,
  );
  assert.deepEqual(skewed, []);
});

test('clipPageBox trusts a clip that every page agrees on', () => {
  const clip = norm(SLIDE);
  const d = clipPageBox([clip, clip, clip], { x0: 0.31, y0: 0.01, x1: 0.69, y1: 0.99 }, W, H);
  assert.equal(d.confidence, 'exact');
  assert.equal(d.ratio.id, '9:16');
  assert.equal(d.centred, true);
  assert.ok(Math.abs(d.box.x0 * W - 253.6562) < 1e-6);
});

test('clipPageBox tolerates a few pages without the clip', () => {
  const clip = norm(SLIDE);
  assert.ok(clipPageBox([clip, clip, clip, clip, null], null, W, H));
  assert.equal(clipPageBox([clip, clip, null, null], null, W, H), null);
});

test('clipPageBox rejects clips that disagree', () => {
  const a = norm(SLIDE), b = norm([200, 0, 600, 595]);
  assert.equal(clipPageBox([a, a, b], null, W, H), null);
});

test('clipPageBox rejects tiny clips and whole-sheet clips', () => {
  assert.equal(clipPageBox([norm([0, 0, 200, 200])], null, W, H), null);
  assert.equal(clipPageBox([norm([0, 0, 842, 595])], null, W, H), null);
});

test('clipPageBox rejects a clip when content is drawn outside it', () => {
  const clip = norm(SLIDE);
  assert.equal(clipPageBox([clip], { x0: 0.1, y0: 0, x1: 0.69, y1: 1 }, W, H), null);
});

test('clipPageBox reports an off-centre page', () => {
  const d = clipPageBox([norm([0, 0, 334.6875, 595])], null, W, H);
  assert.equal(d.centred, false);
  assert.equal(d.ratio.id, '9:16');
});
