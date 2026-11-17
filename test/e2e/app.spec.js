import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mupdf } from '../fixtures.js';
import { FIXTURES } from './make-fixtures.js';

const PDF = path.join(FIXTURES, 'letterboxed.pdf');

async function load(page, file = PDF) {
  await page.goto('/');
  await page.setInputFiles('#file', file);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
}

async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const file = await dl.path();
  await expect(page.locator('.result')).toBeVisible();
  return fs.readFileSync(file);
}

function summarise(bytes) {
  const doc = new mupdf.PDFDocument(bytes);
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const mb = doc.findPage(i).get('MediaBox');
    pages.push([0, 1, 2, 3].map((k) => Math.round(mb.get(k).asNumber() * 100) / 100));
  }
  const filters = [];
  for (let n = 1; n < doc.countObjects(); n++) {
    const o = doc.newIndirect(n);
    if (o.isStream() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Image') filters.push(o.get('Filter').asName());
  }
  // Each fixture page has a marker bar 60 + 30·(page − 1) pt wide.
  const order = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const c = doc.findPage(i).get('Contents');
    const m = c.readStream().asString().match(/520 (\d+) 20 re/);
    order.push(m ? (Number(m[1]) - 60) / 30 + 1 : null);
  }
  return { pages, filters, order };
}

test('reads the exact page outline when the PDF marks it', async ({ page }) => {
  await load(page);
  await expect(page.locator('#detectText')).toHaveText(
    "A 9:16 portrait page, centred on the A4 landscape sheet. The PDF marks this outline itself, so it's exact.");
  await expect(page.locator('#confidence')).toHaveText('Exact');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
  await expect(page.locator('#fmeta')).toContainText('6 pages · A4 landscape');
  await expect(page.locator('#memWarn')).toBeHidden(); // small file, even on a phone
});

test('falls back to detecting the page from pixels', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'letterboxed-noclip.pdf'));
  await expect(page.locator('#detectText')).toHaveText('A 9:16 portrait page, centred on the A4 landscape sheet.');
  await expect(page.locator('#confidence')).toHaveText('Confident');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
});

test('exports the cropped pages with compressed images', async ({ page }) => {
  await load(page);
  const { pages, filters } = summarise(await download(page));
  expect(pages).toHaveLength(6);
  for (const box of pages) expect(box).toEqual([253.66, 0, 588.34, 595]);
  expect(filters).toEqual(['DCTDecode']);
  await expect(page.locator('.result')).toContainText('_200ppi.pdf');
});

test('exports without compression when it is switched off', async ({ page }) => {
  await load(page);
  await page.uncheck('#compress');
  await expect(page.locator('#ppiField')).toBeHidden();
  const { filters } = summarise(await download(page));
  expect(filters).toEqual(['FlateDecode']);
  await expect(page.locator('.result')).toContainText('_cropped.pdf');
});

test('exports only the selected pages', async ({ page }) => {
  await load(page);
  await page.fill('#range', '2-3, 6');
  await page.press('#range', 'Enter');
  await expect(page.locator('#selCount')).toHaveText('3 of 6 selected');
  await expect(page.locator('#download')).toHaveText('Download PDF · 3 pages');
  await expect(page.locator('.thumb.off')).toHaveCount(3);
  const { pages } = summarise(await download(page));
  expect(pages).toHaveLength(3);
});

test('explains a bad page range and keeps the selection', async ({ page }) => {
  await load(page);
  await page.fill('#range', '5-2');
  await page.press('#range', 'Enter');
  await expect(page.locator('#rangeErr')).toHaveText('"5-2" is backwards. Did you mean 2-5?');
  await expect(page.locator('#selCount')).toHaveText('6 of 6 selected');
});

test('page checkboxes and the preview toggle stay in sync', async ({ page }) => {
  await load(page);
  await page.locator('.thumb[data-p="1"] input').uncheck();
  await expect(page.locator('#includePage')).not.toBeChecked();
  await expect(page.locator('#excludedBadge')).toBeVisible();
  await page.check('#includePage');
  await expect(page.locator('.thumb[data-p="1"] input')).toBeChecked();
  await page.click('#selNone');
  await expect(page.locator('#download')).toBeDisabled();
});

test('orientation switch offers landscape presets and flips the box', async ({ page }) => {
  await load(page);
  await page.click('#chips .chip:text-is("3:4")');
  await expect(page.locator('#rSize')).toHaveText('446.3 × 595 pt');
  await page.click('#orientL');
  await expect(page.locator('#chips .chip').nth(1)).toHaveText('16:9');
  await expect(page.locator('#chips [aria-pressed="true"]')).toHaveText('4:3');
  await expect(page.locator('#rSize')).toHaveText('793.3 × 595 pt');
});

test('dragging an edge makes a custom box', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag is covered on desktop');
  await load(page);
  const handle = await page.locator('.h[data-h="e"]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#chips [aria-pressed="true"]')).toHaveText('Custom');
  await page.click('#chips .chip:has-text("Auto")');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
});

test('start over returns to the drop zone', async ({ page }) => {
  await load(page);
  await page.click('#reset');
  await expect(page.locator('#drop')).toBeVisible();
  await expect(page.locator('#work')).toBeHidden();
});

test('loads without console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await load(page);
  expect(errors).toEqual([]);
});

test('makes no requests outside the site, even while exporting', async ({ page, baseURL }) => {
  const external = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['blob:', 'data:'].includes(u.protocol) && u.origin !== new URL(baseURL).origin) external.push(r.url());
  });
  await load(page);
  await download(page);
  expect(external).toEqual([]);
});

test('links a valid web app manifest with its icons', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(href)).json();
  expect(manifest.short_name).toBe('Pared');
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await load(page);
  await expect(page.locator('#detectText')).toContainText('9:16 portrait');
  const { pages, filters } = summarise(await download(page));
  expect(pages).toHaveLength(6);
  expect(filters).toEqual(['DCTDecode']);
});

test('opens a PDF shared from another app', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // What Android does for a share target: POST the file as multipart form data.
  const status = await page.evaluate(async () => {
    const pdf = await (await fetch('test/e2e/.fixtures/letterboxed.pdf')).blob();
    const form = new FormData();
    form.append('pdf', new File([pdf], 'from share.pdf', { type: 'application/pdf' }));
    const res = await fetch('share', { method: 'POST', body: form, redirect: 'manual' });
    return res.type === 'opaqueredirect' ? 'redirect' : res.status;
  });
  expect(status).toBe('redirect');
  await page.goto('/?shared=1');
  await expect(page.locator('#fname')).toHaveText('from share.pdf');
  await expect(page.locator('#detectText')).toContainText('9:16 portrait');
  expect(new URL(page.url()).search).toBe('');
  // The parked file is removed once opened.
  expect(await page.evaluate(async () => !!(await (await caches.open('pared-share')).match('shared.pdf')))).toBe(false);
});

test('frees thumbnails scrolled far away and redraws them on return', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'long.pdf'));
  const first = page.locator('.thumb[data-p="1"] canvas');
  await expect.poll(() => first.evaluate((c) => c.width)).toBeGreaterThan(0);
  await page.locator('#thumbs').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => first.evaluate((c) => c.width)).toBe(0);
  await expect.poll(() => page.locator('.thumb[data-p="120"] canvas').evaluate((c) => c.width)).toBeGreaterThan(0);
  await page.locator('#thumbs').evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(() => first.evaluate((c) => c.width)).toBeGreaterThan(0);
});

const gridOrder = (page) => page.locator('.thumb').evaluateAll((ts) => ts.map((t) => Number(t.dataset.p)));

test('reorders pages from the keyboard and exports them in that order', async ({ page }) => {
  await load(page);
  await page.locator('.thumb[data-p="1"] .tdrag').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect(await gridOrder(page)).toEqual([2, 3, 1, 4, 5, 6]);
  await expect(page.locator('.thumb[data-p="1"] .tdrag')).toBeFocused();
  await expect(page.locator('#pageLabel')).toHaveText('Page 1 of 6 · now 3rd');
  await expect(page.locator('#resetOrder')).toBeVisible();
  const { order } = summarise(await download(page));
  expect(order).toEqual([2, 3, 1, 4, 5, 6]);
});

test('reorders pages by dragging a thumbnail', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag; touch uses the handle');
  await load(page);
  const from = await page.locator('.thumb[data-p="6"] .tclip').boundingBox();
  const to = await page.locator('.thumb[data-p="1"] .tclip').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 5, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await gridOrder(page)).toEqual([6, 1, 2, 3, 4, 5]);
  // The drag must not also open the page in the preview.
  await expect(page.locator('#pageLabel')).toHaveText('Page 1 of 6 · now 2nd');
});

test('reorders pages by dragging the handle on a touch screen', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch only');
  await load(page);
  const handle = page.locator('.thumb[data-p="3"] .tdrag');
  const to = await page.locator('.thumb[data-p="1"] .tclip').boundingBox();
  const from = await handle.boundingBox();
  // Playwright's touchscreen API only taps, so dispatch the pointer events a finger produces.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', from.x + from.width / 2, from.y + from.height / 2);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', from.x + (to.x + 5 - from.x) * (i / 8), from.y + (to.y + to.height / 2 - from.y) * (i / 8));
  }
  await touch('touchEnd');
  expect(await gridOrder(page)).toEqual([3, 1, 2, 4, 5, 6]);
});

test('previous and next follow the new order, and reset restores it', async ({ page }) => {
  await load(page);
  await page.locator('.thumb[data-p="1"] .tdrag').focus();
  await page.keyboard.press('ArrowRight');
  await page.click('.thumb[data-p="2"] .tclip');
  await expect(page.locator('#prev')).toBeDisabled();
  await page.click('#next');
  await expect(page.locator('#pageLabel')).toHaveText('Page 1 of 6 · now 2nd');
  await page.click('#resetOrder');
  expect(await gridOrder(page)).toEqual([1, 2, 3, 4, 5, 6]);
  await expect(page.locator('#resetOrder')).toBeHidden();
  await expect(page.locator('#pageLabel')).toHaveText('Page 1 of 6');
});
