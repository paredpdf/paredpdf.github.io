import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stamp, stampWorker } from '../scripts/stamp.js';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SHA = '91fc7b0e3d2a4c5b6a7980f1e2d3c4b5a6978877';

test('the committed page has empty version tags', () => {
  assert.match(html, /<meta name="pared-commit" content="">/);
  assert.match(html, /<meta name="pared-deployed" content="">/);
});

test('stamps the commit and deploy time', () => {
  const out = stamp(html, SHA, '2026-11-18T14:02:00Z');
  assert.match(out, new RegExp(`<meta name="pared-commit" content="${SHA}">`));
  assert.match(out, /<meta name="pared-deployed" content="2026-11-18T14:02:00Z">/);
  assert.equal(out.length, html.length + SHA.length + '2026-11-18T14:02:00Z'.length);
});

test('refuses bad input instead of deploying a broken page', () => {
  assert.throws(() => stamp(html, '', '2026-11-18T14:02:00Z'), /commit hash/);
  assert.throws(() => stamp(html, 'abc"><script>', '2026-11-18T14:02:00Z'), /commit hash/);
  assert.throws(() => stamp(html, SHA, 'soon'), /time/);
  assert.throws(() => stamp(stamp(html, SHA, '2026-11-18T14:02:00Z'), SHA, '2026-11-18T14:02:00Z'), /no empty/);
});

test('stamps the service worker with the commit', () => {
  const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /const VERSION = 'dev';/);
  const out = stampWorker(sw, SHA);
  assert.match(out, /const VERSION = '91fc7b0e3d2a';/);
  assert.throws(() => stampWorker(out, SHA), /no `const VERSION/);
  assert.throws(() => stampWorker(sw, 'x"; evil()'), /commit hash/);
});
