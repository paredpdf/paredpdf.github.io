import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processPdf, estimateSizes, inspectPdf } from '../pdf-core.js';
import { mupdf, makePdf } from './fixtures.js';

// Opens with "open"; the owner password "boss" also forbids printing.
const locked = () => new mupdf.PDFDocument(makePdf([{ W: 600, H: 400 }, { W: 600, H: 400 }]))
  .saveToBuffer('encrypt=aes-256,user-password=open,owner-password=boss,permissions=-5').asUint8Array().slice();

test('asks for the password, and rejects a wrong one', async () => {
  await assert.rejects(processPdf(mupdf, locked(), {}), (e) => e.code === 'password' && /needs a password/.test(e.message));
  await assert.rejects(processPdf(mupdf, locked(), { password: 'nope' }), (e) => e.code === 'password' && /Wrong password/.test(e.message));
});

test('keeps the original protection by default', async () => {
  const { bytes } = await processPdf(mupdf, locked(), { password: 'open', keep: [1] });
  const out = new mupdf.PDFDocument(bytes);
  assert.equal(out.needsPassword(), true);
  assert.ok(out.authenticatePassword('open'));
  assert.equal(out.countPages(), 1);
  // The owner password and its restrictions survive too.
  const owner = new mupdf.PDFDocument(bytes);
  assert.ok(owner.authenticatePassword('boss') & 4, 'owner password no longer works');
});

test('removes the password when asked', async () => {
  const { bytes } = await processPdf(mupdf, locked(), { password: 'open', removePassword: true });
  assert.equal(new mupdf.PDFDocument(bytes).needsPassword(), false);
});

test('the estimate and the signature check use the password too', async () => {
  const est = await estimateSizes(mupdf, locked(), { password: 'open', presets: [] });
  assert.ok(est.none > 0);
  assert.equal(inspectPdf(mupdf, locked(), 'open').signed, 0);
  assert.throws(() => inspectPdf(mupdf, locked()), (e) => e.code === 'password');
});
