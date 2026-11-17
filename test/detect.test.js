import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL, findContentBox, unionBoxes, detectPageBox, boxForRatio, padBox, ratiosFor, flipRatioId, nameRatio,
} from '../detect.js';

const A4L = { W: 842, H: 595 };
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const widthPt = (box, W) => (box.x1 - box.x0) * W;
const heightPt = (box, H) => (box.y1 - box.y0) * H;
// A content box in points, normalised to the sheet.
const contentPt = (x0, y0, x1, y1, { W, H } = A4L) => ({ x0: x0 / W, y0: y0 / H, x1: x1 / W, y1: y1 / H });

// RGBA image of w×h filled with `bg`, with `rects` ([x0,y0,x1,y1,rgb]) painted on top.
function image(w, h, bg, rects = []) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4);
  for (const [x0, y0, x1, y1, rgb] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...rgb, 255], (y * w + x) * 4);
  }
  return data;
}

test('findContentBox finds the painted area on a white page', () => {
  const box = findContentBox(image(100, 50, [255, 255, 255], [[30, 10, 70, 40, [0, 0, 0]]]), 100, 50);
  assert.deepEqual(box, { x0: 0.3, y0: 0.2, x1: 0.7, y1: 0.8 });
});

test('findContentBox ignores near-white noise below the threshold', () => {
  const box = findContentBox(image(40, 40, [255, 255, 255], [[5, 5, 10, 10, [250, 250, 250]]]), 40, 40);
  assert.equal(box, null);
});

test('findContentBox uses the corner colour as background, not just white', () => {
  const box = findContentBox(image(40, 20, [20, 20, 20], [[10, 5, 30, 15, [200, 100, 50]]]), 40, 20);
  assert.deepEqual(box, { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 });
});

test('findContentBox returns null for a blank page', () => {
  assert.equal(findContentBox(image(10, 10, [255, 255, 255]), 10, 10), null);
});

test('unionBoxes combines boxes and treats null as empty', () => {
  const a = { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 };
  const b = { x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.4 };
  assert.deepEqual(unionBoxes(a, b), { x0: 0.1, y0: 0.1, x1: 0.7, y1: 0.6 });
  assert.equal(unionBoxes(null, b), b);
  assert.equal(unionBoxes(a, null), a);
});

test('detects a 9:16 slide centred on A4 landscape (the Keynote case)', () => {
  // Measured from a real Keynote export: content spans x 253..583, y 5..595.
  const d = detectPageBox(contentPt(253, 5, 583, 595), A4L.W, A4L.H);
  assert.equal(d.ratio.id, '9:16');
  assert.equal(d.confidence, 'high');
  close(d.box.x0 * A4L.W, 253.656);
  close(d.box.x1 * A4L.W, 588.344);
  assert.equal(d.box.y0, 0);
  assert.equal(d.box.y1, 1);
});

test('detects an A4 portrait page centred on A4 landscape', () => {
  const d = detectPageBox(contentPt(215, 12, 627, 583), A4L.W, A4L.H);
  assert.equal(d.ratio.id, 'iso');
  close(widthPt(d.box, A4L.W), 595 / Math.SQRT2);
});

test('detects a 16:9 slide letterboxed top and bottom on A4 portrait', () => {
  const W = 595, H = 842;
  const slideH = (W * 9) / 16;
  const top = (H - slideH) / 2;
  const d = detectPageBox(contentPt(8, top + 4, W - 8, top + slideH - 4, { W, H }), W, H);
  assert.equal(d.ratio.id, '9:16-l');
  assert.equal(d.reason, 'top-bands');
  close(heightPt(d.box, H), slideH);
});

test('never snaps to a ratio that would cut content', () => {
  // Content needs 400pt of width: 2:3 (396.7pt) is too narrow, A4 (420.7pt) fits.
  const d = detectPageBox(contentPt(221, 0, 621, 595), A4L.W, A4L.H);
  assert.equal(d.ratio.id, 'iso');
  assert.ok(widthPt(d.box, A4L.W) >= 400 - 2.4);
});

test('reports a page that already fills the sheet', () => {
  const d = detectPageBox({ x0: 0.01, y0: 0.01, x1: 0.99, y1: 0.99 }, A4L.W, A4L.H);
  assert.equal(d.reason, 'fills-sheet');
  assert.deepEqual(d.box, FULL);
});

test('reports blank pages', () => {
  const d = detectPageBox(null, A4L.W, A4L.H);
  assert.equal(d.reason, 'blank');
  assert.equal(d.confidence, 'low');
});

test('is less confident when the content is off-centre', () => {
  const d = detectPageBox(contentPt(100, 0, 430, 595), A4L.W, A4L.H);
  assert.equal(d.confidence, 'low');
});

test('boxForRatio fits the largest centred box of a ratio', () => {
  const p = boxForRatio(3 / 4, A4L.W, A4L.H);
  close(widthPt(p, A4L.W), 446.25);
  assert.equal(heightPt(p, A4L.H), 595);
  close(p.x0, 1 - p.x1);
  // Wider than the sheet: full width, letterboxed vertically.
  const l = boxForRatio(16 / 9, A4L.W, A4L.H);
  assert.equal(widthPt(l, A4L.W), 842);
  close(heightPt(l, A4L.H), (842 * 9) / 16);
});

test('padBox grows a box but stays on the sheet', () => {
  assert.deepEqual(padBox({ x0: 0.005, y0: 0.5, x1: 0.6, y1: 0.995 }, 0.01), { x0: 0, y0: 0.49, x1: 0.61, y1: 1 });
});

test('ratiosFor returns one orientation, with 1:1 in both', () => {
  const portrait = ratiosFor('portrait'), landscape = ratiosFor('landscape');
  assert.ok(portrait.every((r) => r.r <= 1));
  assert.ok(landscape.every((r) => r.r >= 1));
  assert.ok(portrait.some((r) => r.id === '1:1') && landscape.some((r) => r.id === '1:1'));
  assert.deepEqual(landscape.map((r) => r.label).slice(0, 4), ['16:9', '3:2', 'A4', '4:3']);
});

test('flipRatioId swaps orientation and keeps 1:1', () => {
  assert.equal(flipRatioId('3:4'), '3:4-l');
  assert.equal(flipRatioId('3:4-l'), '3:4');
  assert.equal(flipRatioId('1:1'), '1:1');
});

test('nameRatio names common shapes and nothing else', () => {
  assert.equal(nameRatio(334.6875, 595), '9:16');
  assert.equal(nameRatio(595, 842), 'A4');
  assert.equal(nameRatio(800, 600), '4:3');
  assert.equal(nameRatio(500, 600), null);
});
