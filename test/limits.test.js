import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLargeForDevice, isMemoryError, LARGE_FILE_BYTES } from '../limits.js';

test('small files never warn', () => {
  assert.equal(isLargeForDevice(LARGE_FILE_BYTES - 1, { deviceMemory: 1, coarsePointer: true }), false);
});

test('large files warn on touch devices and low-memory devices', () => {
  assert.equal(isLargeForDevice(150e6, { coarsePointer: true }), true);
  assert.equal(isLargeForDevice(150e6, { deviceMemory: 4 }), true);
});

test('large files do not warn on a desktop with plenty of memory', () => {
  assert.equal(isLargeForDevice(150e6, { deviceMemory: 8, coarsePointer: false }), false);
  assert.equal(isLargeForDevice(150e6, {}), false);
});

test('recognises out-of-memory errors', () => {
  assert.equal(isMemoryError(new RangeError('Array buffer allocation failed')), true);
  assert.equal(isMemoryError(new Error('RuntimeError: memory access out of bounds')), true);
  assert.equal(isMemoryError(new Error('Aborted(OOM)')), true);
  assert.equal(isMemoryError('Cannot enlarge memory arrays'), true);
});

test('does not mistake other errors for memory errors', () => {
  assert.equal(isMemoryError(new Error('No pages selected')), false);
  assert.equal(isMemoryError(new Error('cannot find object in xref')), false);
  assert.equal(isMemoryError(undefined), false);
});
