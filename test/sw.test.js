import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const list = (name) => [...sw.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('the vendor cache name changes with the library versions', () => {
  const name = sw.match(/const VENDOR_CACHE = '([^']+)'/)[1];
  assert.ok(name.includes(`pdfjs-${pkg.devDependencies['pdfjs-dist']}`), `${name} doesn't match pdfjs-dist ${pkg.devDependencies['pdfjs-dist']}`);
  assert.ok(name.includes(`mupdf-${pkg.devDependencies.mupdf}`), `${name} doesn't match mupdf ${pkg.devDependencies.mupdf}`);
});

test('every precached file exists', () => {
  for (const f of [...list('APP_FILES'), ...list('VENDOR_FILES')]) {
    if (f === './') continue;
    assert.ok(fs.existsSync(new URL(`../${f}`, import.meta.url)), `${f} is precached but missing`);
  }
});

test('every app file the page needs is precached', () => {
  const app = new Set(list('APP_FILES'));
  const notServed = new Set(['sw.js', 'playwright.config.js']);
  const root = fs.readdirSync(new URL('..', import.meta.url)).filter((f) => /\.(js|css|html)$/.test(f) && !notServed.has(f));
  for (const f of root) assert.ok(app.has(f), `${f} is not in APP_FILES, so it won't work offline`);
});

test('every vendored font is precached, and the cache name has the font version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const fonts = fs.readdirSync(new URL('../vendor/fonts', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.woff2'));
  const pre = new Set(list('VENDOR_FILES'));
  for (const f of fonts) assert.ok(pre.has(`vendor/fonts/${f}`), `vendor/fonts/${f} is not precached`);
  const name = sw.match(/const VENDOR_CACHE = '([^']+)'/)[1];
  assert.ok(name.endsWith(`fonts-${pkg.devDependencies['@fontsource/caveat']}`), name);
});
