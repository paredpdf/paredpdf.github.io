import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontsFor, inkAlpha } from '../sign.js';

const ids = (text) => fontsFor(text).map((f) => f.id);

test('offers every style for Latin names', () => {
  assert.deepEqual(ids('Ada Lovelace'), ['dancing', 'caveat', 'gveret', 'ruqaa']);
});

test('offers only styles that can write Hebrew or Arabic', () => {
  assert.deepEqual(ids('שי אפשטיין'), ['gveret']);
  assert.deepEqual(ids('ليلى'), ['ruqaa']);
  assert.deepEqual(ids('Shai שי'), ['gveret']);
  // No single style writes both, so all are offered and fallbacks fill in.
  assert.equal(ids('שי ليلى').length, 4);
});

// One row of RGBA pixels from grey levels.
const row = (levels) => Uint8ClampedArray.from(levels.flatMap((v) => [v, v, v, 255]));

test('turns paper transparent and ink opaque, even on grey paper', () => {
  // Mostly grey paper (210), a few dark ink pixels, one mid-grey edge.
  const levels = [...Array(20).fill(210), 30, 30, 120];
  const a = inkAlpha(row(levels), levels.length, 1);
  assert.equal(a[0], 0);
  assert.equal(a[20], 255);
  assert.ok(a[22] > 0 && a[22] < 255, `edge ${a[22]}`);
});

test('transparent pixels in the photo count as paper', () => {
  const rgba = Uint8ClampedArray.from([0, 0, 0, 0, ...Array(10).fill([240, 240, 240, 255]).flat()]);
  assert.equal(inkAlpha(rgba, 11, 1)[0], 0);
});
