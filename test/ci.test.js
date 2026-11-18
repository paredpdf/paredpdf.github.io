import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const config = fs.readFileSync(new URL('../playwright.config.js', import.meta.url), 'utf8');

test('the CI browser image matches the Playwright version in package.json', () => {
  const tag = workflow.match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1];
  assert.equal(tag, pkg.devDependencies['@playwright/test'], 'update the image tag in .github/workflows/test.yml');
});

test('CI runs every Playwright project', () => {
  const inConfig = [...config.matchAll(/name: '(\w+)'/g)].map((m) => m[1]).sort();
  const inCi = JSON.parse(workflow.match(/project: (\[[^\]]+\])/)[1].replace(/(\w+)/g, '"$1"')).sort();
  assert.deepEqual(inCi, inConfig);
});
