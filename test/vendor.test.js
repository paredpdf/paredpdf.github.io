import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vendorFiles } from '../scripts/vendor.js';

test('vendor/ matches the pdf.js and mupdf versions in package.json', () => {
  const files = vendorFiles();
  assert.ok(files.length > 10);
  for (const [src, dst] of files) {
    assert.ok(fs.existsSync(dst), `missing ${path.relative(process.cwd(), dst)}; run npm run vendor`);
    assert.ok(fs.readFileSync(src).equals(fs.readFileSync(dst)), `${path.relative(process.cwd(), dst)} is out of date; run npm run vendor`);
  }
});
