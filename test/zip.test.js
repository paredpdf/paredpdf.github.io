import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeZip, crc32 } from '../zip.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('writes a ZIP that standard tools read back exactly', () => {
  const files = [
    { name: 'deck_part1.pdf', bytes: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255) },
    { name: 'דוח_part2.pdf', bytes: new TextEncoder().encode('%PDF-1.7 hello') }, // non-ASCII name
    { name: 'empty.pdf', bytes: new Uint8Array(0) },
  ];
  // A scratch folder inside the project (ignored by git).
  const base = new URL('../test-results/', import.meta.url).pathname;
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'zip-'));
  try {
    const zipPath = path.join(dir, 'out.zip');
    fs.writeFileSync(zipPath, makeZip(files));
    // Python's zipfile checks every CRC and the directory structure.
    const out = execFileSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps([[i.filename, list(z.read(i))[:20], i.file_size] for i in z.infolist()]))
`, zipPath], { encoding: 'utf8' });
    const got = JSON.parse(out);
    assert.deepEqual(got.map((g) => g[0]), files.map((f) => f.name));
    got.forEach(([, head, size], k) => {
      assert.equal(size, files[k].bytes.length);
      assert.deepEqual(head, [...files[k].bytes.subarray(0, 20)]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
