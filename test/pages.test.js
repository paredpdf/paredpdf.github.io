import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, formatRange } from '../pages.js';

test('empty or "all" selects every page', () => {
  assert.deepEqual(parseRange('', 4), [1, 2, 3, 4]);
  assert.deepEqual(parseRange('  ', 3), [1, 2, 3]);
  assert.deepEqual(parseRange('All', 2), [1, 2]);
});

test('parses single pages and ranges', () => {
  assert.deepEqual(parseRange('1-3, 5', 10), [1, 2, 3, 5]);
  assert.deepEqual(parseRange('8', 10), [8]);
});

test('accepts spaces, en dashes and semicolons', () => {
  assert.deepEqual(parseRange('1 - 3 ; 7–8', 10), [1, 2, 3, 7, 8]);
  assert.deepEqual(parseRange('2 4 6', 10), [2, 4, 6]);
});

test('open-ended ranges run to the first or last page', () => {
  assert.deepEqual(parseRange('8-', 10), [8, 9, 10]);
  assert.deepEqual(parseRange('-2', 10), [1, 2]);
});

test('sorts and removes duplicates', () => {
  assert.deepEqual(parseRange('5, 1-3, 2, 5', 10), [1, 2, 3, 5]);
});

test('rejects text that is not a page or range', () => {
  assert.throws(() => parseRange('1-3, abc', 10), /"abc" isn't a page or range/);
  assert.throws(() => parseRange('1-2-3', 10), /isn't a page or range/);
});

test('rejects pages outside the document', () => {
  assert.throws(() => parseRange('0', 10), /"0" is outside 1-10/);
  assert.throws(() => parseRange('9-11', 10), /"9-11" is outside 1-10/);
});

test('formatRange collapses runs of consecutive pages', () => {
  assert.equal(formatRange([1, 2, 3, 5, 7, 8]), '1-3, 5, 7-8');
  assert.equal(formatRange([4]), '4');
  assert.equal(formatRange([]), '');
});

test('formatRange output parses back to the same pages', () => {
  const pages = [1, 2, 5, 9, 10, 11, 20];
  assert.deepEqual(parseRange(formatRange(pages), 20), pages);
});
