import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf, estimateSizes, inspectPdf } from '../pdf-core.js';
import { mupdf, makePdf, inspect, signedPdf } from './fixtures.js';

const widths = (bytes) => inspect(bytes).pages.map((p) => p.mediaBox[2]);
// Three files whose pages are told apart by width.
const a = () => makePdf([{ W: 100, H: 400 }, { W: 110, H: 400 }]);
const b = () => makePdf([{ W: 200, H: 400, draw: [{ image: { w: 300, h: 200, seed: 4 }, at: [0, 0, 150, 100] }] }]);
const c = () => makePdf([{ W: 300, H: 400 }, { W: 310, H: 400 }, { W: 320, H: 400 }]);

test('merges several PDFs in order', async () => {
  const { bytes } = await processPdf(mupdf, [{ bytes: a() }, { bytes: b() }, { bytes: c() }], {});
  assert.deepEqual(widths(bytes), [100, 110, 200, 300, 310, 320]);
  assert.equal(inspect(bytes).images.length, 1);
});

test('page options count through all the merged files', async () => {
  const { bytes } = await processPdf(mupdf, [{ bytes: a() }, { bytes: c() }], {
    keep: [4, 0, 2], rotate: [0, 0, 90, 0, 0], boxes: [null, null, [0, 0, 150, 300], null, null],
  });
  assert.deepEqual(widths(bytes), [320, 100, 150]);
  assert.deepEqual(inspect(bytes).pages.map((p) => p.rotate), [0, 0, 90]);
});

test('splits the result into parts', async () => {
  const { bytes, parts } = await processPdf(mupdf, [{ bytes: a() }, { bytes: c() }], { split: [[0, 1], [2, 3, 4]] });
  assert.deepEqual(widths(bytes), [100, 110, 300, 310, 320]);
  assert.deepEqual(parts.map(widths), [[100, 110], [300, 310, 320]]);
});

test('splits a single file every page', async () => {
  const { parts } = await processPdf(mupdf, c(), { split: [[0], [1], [2]] });
  assert.deepEqual(parts.map(widths), [[300], [310], [320]]);
});

const locked = (pw) => new mupdf.PDFDocument(a()).saveToBuffer(`encrypt=aes-256,user-password=${pw},owner-password=${pw}x`).asUint8Array().slice();

test('merges protected files, protecting the result with the first password', async () => {
  const sources = [{ bytes: c() }, { bytes: locked('one'), password: 'one' }, { bytes: locked('two'), password: 'two' }];
  const { bytes, parts } = await processPdf(mupdf, sources, { split: [[0], [3, 4]] });
  const out = new mupdf.PDFDocument(bytes);
  assert.equal(out.needsPassword(), true);
  assert.ok(out.authenticatePassword('one'));
  assert.equal(out.countPages(), 7);
  for (const p of parts) {
    const d = new mupdf.PDFDocument(p);
    assert.ok(d.needsPassword() && d.authenticatePassword('one'));
  }
  const open = await processPdf(mupdf, sources, { removePassword: true, split: [[0]] });
  assert.equal(new mupdf.PDFDocument(open.bytes).needsPassword(), false);
  assert.equal(new mupdf.PDFDocument(open.parts[0]).needsPassword(), false);
});

test('a merged file needs every password', async () => {
  await assert.rejects(processPdf(mupdf, [{ bytes: c() }, { bytes: locked('one') }], {}), (e) => e.code === 'password');
});

test('estimates and inspects merged files', async () => {
  const sources = [{ bytes: a() }, { bytes: b() }];
  const est = await estimateSizes(mupdf, sources, { presets: [] });
  const { bytes } = await processPdf(mupdf, sources, {});
  assert.equal(est.none, bytes.length);
  assert.equal(inspectPdf(mupdf, [{ bytes: a() }, { bytes: signedPdf(2) }, { bytes: signedPdf(1) }]).signed, 3);
});
