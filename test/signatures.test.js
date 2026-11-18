import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPdf } from '../pdf-core.js';
import { mupdf, makePdf, signedPdf } from './fixtures.js';

test('finds no signatures in an ordinary PDF', () => {
  assert.deepEqual(inspectPdf(mupdf, makePdf([{ W: 595, H: 842 }])), { signed: 0 });
});

test('counts signed signature fields, even inside compressed object streams', () => {
  assert.deepEqual(inspectPdf(mupdf, signedPdf(1)), { signed: 1 });
  assert.deepEqual(inspectPdf(mupdf, signedPdf(2)), { signed: 2 });
});

test('does not count empty signature fields waiting to be signed', () => {
  assert.deepEqual(inspectPdf(mupdf, signedPdf(2, { unsigned: 1 })), { signed: 2 });
  assert.deepEqual(inspectPdf(mupdf, signedPdf(0, { unsigned: 2 })), { signed: 0 });
});

test('finds signature fields nested under a parent field', () => {
  assert.deepEqual(inspectPdf(mupdf, signedPdf(1, { nested: true })), { signed: 1 });
});
