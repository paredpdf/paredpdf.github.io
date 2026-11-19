import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { mupdf } from '../fixtures.js';
import { FIXTURES } from './make-fixtures.js';

const PDF = path.join(FIXTURES, 'letterboxed.pdf');

async function load(page, file = PDF, url = '/') {
  await page.goto(url);
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
  const rotate = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const r = doc.findPage(i).getInheritable('Rotate');
    rotate.push(r.isNumber() ? r.asNumber() : 0);
  }
  return { pages, filters, order, rotate };
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

const MB = (t) => Number(t.match(/≈ ([\d.]+) MB/)?.[1]);
const KB = (t) => { const m = t.match(/≈ ([\d.]+) (KB|MB)/); return m ? Number(m[1]) * (m[2] === 'MB' ? 1000 : 1) : NaN; };

test('estimates the size before export, close to the real result', async ({ page }) => {
  await load(page);
  await expect(page.locator('#estimate')).toContainText('Estimated size: ≈', { timeout: 30_000 });
  await expect(page.locator('#ppi option[value="150"]')).toContainText('≈');
  const est = KB(await page.locator('#estimate').textContent());
  const actual = (await download(page)).length / 1000;
  expect(Math.abs(est - actual) / actual).toBeLessThan(0.25);

  // Switching compression off shows the uncompressed estimate.
  await page.uncheck('#compress');
  expect(KB(await page.locator('#estimate').textContent())).toBeGreaterThan(est * 2);
});

test('updates the estimate when pages are skipped', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'photos.pdf'));
  await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
  const all = KB(await page.locator('#estimate').textContent());
  await page.fill('#range', '1');
  await page.press('#range', 'Enter');
  await expect(page.locator('#selCount')).toHaveText('1 of 3 selected');
  await expect.poll(async () => KB(await page.locator('#estimate').textContent()), { timeout: 30_000 }).toBeLessThan(all * 0.6);
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

test('reorders pages by dragging the handle on a touch screen', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile, 'touch only');
  test.skip(browserName !== 'chromium', 'fakes touch input through the Chrome DevTools protocol');
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

test('rotates pages and exports the rotation', async ({ page }) => {
  await load(page);
  const rot = page.locator('.thumb[data-p="2"] .trot');
  await rot.click();
  await expect(page.locator('.thumb[data-p="2"] .tclip')).toHaveCSS('transform', /matrix/);
  await rot.click();
  await page.locator('.thumb[data-p="4"] .trot').click();
  await page.click('.thumb[data-p="2"] .tclip');
  await expect(page.locator('#rotBadge')).toHaveText('Turned 180° clockwise in the export');
  const { rotate } = summarise(await download(page));
  expect(rotate).toEqual([0, 180, 0, 90, 0, 0]);
});

test('four turns bring a page back to upright', async ({ page }) => {
  await load(page);
  const rot = page.locator('.thumb[data-p="1"] .trot');
  for (let i = 0; i < 4; i++) await rot.click();
  await expect(page.locator('#rotBadge')).toBeHidden();
  await expect(page.locator('.thumb[data-p="1"] .tclip')).toHaveCSS('transform', 'none');
});

test('gives one page its own crop', async ({ page }) => {
  await load(page);
  await page.click('.thumb[data-p="2"] .tclip');
  await page.click('#scopePage');
  await page.click('#chips .chip:text-is("3:4")');
  await expect(page.locator('#rSize')).toHaveText('446.3 × 595 pt');
  await expect(page.locator('#scopeHint')).toHaveText('Only page 2 uses this crop. The other pages keep the shared one.');
  await expect(page.locator('.thumb.own')).toHaveCount(1);
  // Other pages still use the shared crop.
  await page.click('.thumb[data-p="3"] .tclip');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
  await expect(page.locator('#scopeAll')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#scopeHint')).toHaveText('1 page has its own crop.');
  const { pages } = summarise(await download(page));
  expect(pages.map((b) => Math.round(b[2] - b[0]))).toEqual([335, 446, 335, 335, 335, 335]);
});

test('a page with its own crop can go back to the shared one', async ({ page }) => {
  await load(page);
  await page.click('.thumb[data-p="2"] .tclip');
  await page.click('#scopePage');
  await page.click('#chips .chip:text-is("1:1")');
  await page.click('#scopeAll');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
  await expect(page.locator('.thumb.own')).toHaveCount(0);
  await expect(page.locator('#scopeHint')).toBeHidden();
});

test('changing the shared crop leaves pages with their own crop alone', async ({ page }) => {
  await load(page);
  await page.click('.thumb[data-p="2"] .tclip');
  await page.click('#scopePage');
  await page.click('.thumb[data-p="1"] .tclip');
  await page.click('#chips .chip:text-is("1:1")');
  const { pages } = summarise(await download(page));
  expect(pages.map((b) => Math.round(b[2] - b[0]))).toEqual([595, 335, 595, 595, 595, 595]);
});

/* ---------- Hebrew (right to left) ---------- */

const HE = (page, file = PDF) => load(page, file, '/?lang=he');

test('shows the interface in Hebrew, right to left', async ({ page }) => {
  await page.goto('/?lang=he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('#drop h1')).toHaveText('גררו לכאן קובץ PDF');
  await expect(page.locator('#lang')).toHaveValue('he');
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#confidence')).toHaveText('מדויק');
  await expect(page.locator('#detectText')).toContainText('ממורכז על גיליון');
  await expect(page.locator('#selCount')).toHaveText('6 מתוך 6 נבחרו');
  await expect(page.locator('#download')).toHaveText('הורדת PDF · 6 עמודים');
  await expect(page.locator('#pageLabel')).toHaveText('עמוד 1 מתוך 6');
  // Measurements stay in one left-to-right piece.
  expect(await page.locator('#rSize').textContent()).toBe('\u2066334.7 × 595 pt\u2069');
  // The preview's crop handles keep their physical sides.
  await expect(page.locator('#stageWrap')).toHaveAttribute('dir', 'ltr');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('switches language with a loaded file, and remembers the choice', async ({ page }) => {
  await load(page);
  await expect(page.locator('#selCount')).toHaveText('6 of 6 selected');
  await page.selectOption('#lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#selCount')).toHaveText('6 מתוך 6 נבחרו');
  await expect(page.locator('#confidence')).toHaveText('מדויק');
  await expect(page.locator('#fmeta')).toContainText('6 עמודים · \u2066A4\u2069 לרוחב');
  await expect(page.locator('.thumb[data-p="2"] .trot')).toHaveAttribute('aria-label', 'סיבוב עמוד 2 עם כיוון השעון');
  await expect(page.locator('#compressHint')).toContainText('JPEG');
  await expect(page.locator('#estimate')).toContainText('גודל משוער', { timeout: 30_000 });

  await page.reload();
  await expect(page.locator('#drop h1')).toHaveText('גררו לכאן קובץ PDF');
  await expect(page.locator('#lang')).toHaveValue('he');
  await page.selectOption('#lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#drop h1')).toHaveText('Drop a PDF here');
});

test('in Hebrew, the left arrow moves pages forward', async ({ page }) => {
  await HE(page);
  await page.locator('.thumb[data-p="1"] .tdrag').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await gridOrder(page)).toEqual([2, 3, 1, 4, 5, 6]);
  await page.keyboard.press('ArrowRight');
  expect(await gridOrder(page)).toEqual([2, 1, 3, 4, 5, 6]);
  await expect(page.locator('#pageLabel')).toHaveText('עמוד 1 מתוך 6 · עכשיו במקום 2');

  // The pager follows the same direction.
  await page.click('.thumb[data-p="2"] .tclip');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#pageLabel')).toHaveText('עמוד 1 מתוך 6 · עכשיו במקום 2');
  const { order } = summarise(await download(page));
  expect(order).toEqual([2, 1, 3, 4, 5, 6]);
  await expect(page.locator('.result')).toContainText('נשמר');
});

test('in Hebrew, dropping on the right half of a thumbnail puts the page before it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag; touch uses the handle');
  await HE(page);
  const from = await page.locator('.thumb[data-p="6"] .tclip').boundingBox();
  const to = await page.locator('.thumb[data-p="1"] .tclip').boundingBox();
  const second = await page.locator('.thumb[data-p="2"] .tclip').boundingBox();
  expect(to.x).toBeGreaterThan(second.x); // pages run right to left
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 5, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await gridOrder(page)).toEqual([6, 1, 2, 3, 4, 5]);
});

test('explains a bad page range in Hebrew', async ({ page }) => {
  await HE(page);
  await page.fill('#range', '5-2');
  await page.press('#range', 'Enter');
  await expect(page.locator('#rangeErr')).toHaveText('"5-2" הפוך. התכוונתם ל־2-5?');
});

/* ---------- version footer ---------- */

test('a copy served from the repo shows the source link but no version', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.foot a').first()).toHaveText('Source code');
  await expect(page.locator('#version')).toBeHidden();
});

test('a deployed copy shows its commit and deploy time', async ({ page }) => {
  const { stamp } = await import('../../scripts/stamp.js');
  const sha = '91fc7b0e3d2a4c5b6a7980f1e2d3c4b5a6978877';
  await page.route(/\/(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: stamp(await res.text(), sha, '2026-11-18T14:02:00Z') });
  });
  await page.goto('/');
  const link = page.locator('#versionLink');
  await expect(link).toHaveText(/^Version 91fc7b0, deployed 18 Nov 2026, \d\d:02$/);
  await expect(link).toHaveAttribute('href', `https://github.com/paredpdf/paredpdf.github.io/commit/${sha}`);
  await page.selectOption('#lang', 'he');
  await expect(link).toHaveText(/^גרסה ⁦91fc7b0⁩, עלתה ב־.*2026/);
});

/* ---------- Arabic and Spanish ---------- */

test('shows the interface in Arabic, right to left', async ({ page }) => {
  await load(page, PDF, '/?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('#confidence')).toHaveText('دقيق');
  await expect(page.locator('#selCount')).toHaveText('تم تحديد 6 من 6');
  await expect(page.locator('#download')).toHaveText('تنزيل PDF · 6 صفحات');
  // Arabic keyboards type ، between parts of a range.
  await page.fill('#range', '1، 3');
  await page.press('#range', 'Enter');
  await expect(page.locator('#download')).toHaveText('تنزيل PDF · صفحتان');
  // Right to left like Hebrew: the left arrow moves a page forward.
  await page.locator('.thumb[data-p="1"] .tdrag').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await gridOrder(page)).toEqual([2, 1, 3, 4, 5, 6]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('shows the interface in Spanish', async ({ page }) => {
  await load(page, PDF, '/?lang=es');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#confidence')).toHaveText('Exacta');
  await expect(page.locator('#detectText')).toHaveText(
    'Una página 9:16 vertical, centrada en la hoja A4 horizontal. El propio PDF marca este contorno, así que es exacto.');
  await expect(page.locator('#selCount')).toHaveText('6 de 6 seleccionadas');
  await page.fill('#range', '5-2');
  await page.press('#range', 'Enter');
  await expect(page.locator('#rangeErr')).toHaveText('"5-2" está al revés. ¿Querías decir 2-5?');
});

test('picks the language from the browser', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'es-MX' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('#drop h1')).toHaveText('Suelta un PDF aquí');
  await expect(page.locator('#lang')).toHaveValue('es');
  await context.close();
});

/* ---------- existing digital signatures ---------- */

test('warns that exporting breaks an existing digital signature', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'signed.pdf'));
  const warn = page.locator('#sigWarn');
  await expect(warn).toHaveText(/^This PDF is digitally signed\. Exporting rewrites the file/, { timeout: 30_000 });
  await page.selectOption('#lang', 'he');
  await expect(warn).toContainText('חתום דיגיטלית');
});

test('no signature warning for an empty signature field or an ordinary PDF', async ({ page }) => {
  for (const f of ['unsigned-field.pdf', 'letterboxed.pdf']) {
    await load(page, path.join(FIXTURES, f));
    await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
    await expect(page.locator('#sigWarn')).toBeHidden();
  }
});

/* ---------- visual signatures ---------- */

// Signatures each exported page carries: the rectangle each is drawn in.
function signatures(bytes) {
  const doc = new mupdf.PDFDocument(bytes);
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const c = doc.findPage(i).get('Contents');
    const last = c.isArray() ? c.get(c.length - 1) : c;
    const text = last.readStream().asString();
    const rects = [...text.matchAll(/q ([-\d. ]+) cm \/PaSig\w* Do Q/g)].map((m) => {
      const [a, b, cc, d, e, f] = m[1].trim().split(/\s+/).map(Number);
      const xs = [e, e + a, e + cc, e + a + cc], ys = [f, f + b, f + d, f + b + d];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    const mb = doc.findPage(i).get('MediaBox');
    out.push({ rects, media: [0, 1, 2, 3].map((k) => mb.get(k).asNumber()) });
  }
  return out;
}

async function drawSignature(page) {
  await page.click('#addSign');
  await expect(page.locator('#signDlg')).toBeVisible();
  const box = await page.locator('#pad').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  for (let k = 1; k <= 20; k++) await page.mouse.move(box.x + 40 + k * 12, box.y + 120 - 50 * Math.sin(k / 3));
  await page.mouse.up();
  await expect(page.locator('#sigUse')).toBeEnabled();
  await page.click('#sigUse');
  await expect(page.locator('#signDlg')).toBeHidden();
}

test('draws a signature, places it, and exports it on that page', async ({ page }) => {
  await load(page);
  await drawSignature(page);
  const sig = page.locator('.sig');
  await expect(sig).toHaveCount(1);
  await expect(sig).toBeFocused();
  await expect(page.locator('#signHint')).toBeVisible();
  // Other pages don't show it.
  await page.click('#next');
  await expect(page.locator('.sig')).toHaveCount(0);
  await page.click('#prev');
  await expect(page.locator('.sig')).toHaveCount(1);

  const pages = signatures(await download(page));
  expect(pages[0].rects).toHaveLength(1);
  expect(pages.slice(1).every((p) => p.rects.length === 0)).toBe(true);
  // Inside the cropped page.
  const [x0, y0, x1, y1] = pages[0].rects[0], m = pages[0].media;
  expect(x0 >= m[0] - 0.5 && y0 >= m[1] - 0.5 && x1 <= m[2] + 0.5 && y1 <= m[3] + 0.5).toBe(true);
  expect(x1 - x0).toBeGreaterThan(50);
});

test('moves a signature with the keyboard and removes it with Delete', async ({ page }) => {
  await load(page);
  await drawSignature(page);
  const sig = page.locator('.sig');
  const before = await sig.boundingBox();
  await page.keyboard.press('Shift+ArrowDown');
  const after = await sig.boundingBox();
  expect(after.y).toBeGreaterThan(before.y + 5);
  await expect(page.locator('#pageLabel')).toHaveText('Page 1 of 6'); // arrows didn't turn the page
  await page.keyboard.press('Delete');
  await expect(sig).toHaveCount(0);
  expect(signatures(await download(page))[0].rects).toHaveLength(0);
});

test('keeps a dragged signature inside the crop area', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await load(page);
  await drawSignature(page);
  const sig = page.locator('.sig');
  const s = await sig.boundingBox();
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  // Past the crop's bottom-left corner, staying inside the window.
  const crop = await page.locator('#crop').boundingBox();
  await page.mouse.move(crop.x - 150, crop.y + crop.height + 100, { steps: 8 });
  await page.mouse.up();
  const now = await sig.boundingBox();
  expect(now.x).toBeGreaterThanOrEqual(crop.x - 1);
  expect(now.y + now.height).toBeLessThanOrEqual(crop.y + crop.height + 1);
  // Resize from the corner, keeping its shape.
  const ratio = now.width / now.height;
  const rs = await page.locator('.sig-rs').boundingBox();
  await page.mouse.move(rs.x + rs.width / 2, rs.y + rs.height / 2);
  await page.mouse.down();
  await page.mouse.move(rs.x + rs.width / 2 + 40, rs.y + rs.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  const big = await sig.boundingBox();
  expect(big.width).toBeGreaterThan(now.width + 30);
  expect(Math.abs(big.width / big.height - ratio)).toBeLessThan(0.05);
});

test('turns a photo of a signature into transparent ink', async ({ page }) => {
  await load(page);
  await page.click('#addSign');
  await page.click('#tabUpload');
  await page.setInputFiles('#sigFile', path.join(FIXTURES, 'blank.png'));
  await expect(page.locator('#sigErr')).toBeVisible();
  await expect(page.locator('#sigUse')).toBeDisabled();
  await page.setInputFiles('#sigFile', path.join(FIXTURES, 'signature.png'));
  await expect(page.locator('#sigImg')).toBeVisible();
  await expect(page.locator('#sigErr')).toBeHidden();
  // The paper is gone: corners are transparent, the stroke is opaque ink.
  const alpha = await page.locator('#sigImg').evaluate(async (img) => {
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let max = 0;
    for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]);
    return { corner: d[3], max };
  });
  expect(alpha.corner).toBe(0);
  expect(alpha.max).toBe(255);
  await page.click('#sigUse');
  await expect(page.locator('.sig')).toHaveCount(1);
  expect(signatures(await download(page))[0].rects).toHaveLength(1);
});

test('a signature on a skipped page is not exported', async ({ page }) => {
  await load(page);
  await drawSignature(page);
  await page.uncheck('#includePage');
  const pages = signatures(await download(page));
  expect(pages).toHaveLength(5);
  expect(pages.every((p) => p.rects.length === 0)).toBe(true);
});

test('the signature dialog speaks the chosen language', async ({ page }) => {
  await load(page, PDF, '/?lang=es');
  await page.click('#addSign');
  await expect(page.locator('#signDlgTitle')).toHaveText('Tu firma');
  await expect(page.locator('#sigUse')).toHaveText('Añadir a la página');
  await page.click('#sigCancel');
  await expect(page.locator('#signDlg')).toBeHidden();
});

async function typeSignature(page, name, style) {
  await page.click('#addSign');
  await page.click('#tabType');
  await expect(page.locator('#sigName')).toBeFocused();
  await page.fill('#sigName', name);
  if (style) await page.click(`.fontchip[title="${style}"]`);
  await page.click('#sigUse');
  await expect(page.locator('#signDlg')).toBeHidden();
  await expect(page.locator('.sig img').last()).toHaveAttribute('src', /^data:image\/png/);
}

test('types a signature in a handwriting font and exports it', async ({ page }) => {
  await load(page);
  await page.click('#addSign');
  await page.click('#tabType');
  await expect(page.locator('#sigUse')).toBeDisabled(); // nothing typed yet
  await page.click('#sigCancel');
  await typeSignature(page, 'Ada Lovelace', 'Caveat');
  // The handwriting font itself was used, not a fallback.
  expect(await page.evaluate(() => document.fonts.check('20px "Pared Caveat"', 'Ada'))).toBe(true);
  // A wide, short box: the shape of a written name.
  const b = await page.locator('.sig').boundingBox();
  expect(b.width / b.height).toBeGreaterThan(3);
  expect(signatures(await download(page))[0].rects).toHaveLength(1);
});

test('typed names in Hebrew and Arabic get a handwriting font for their script', async ({ page }) => {
  await load(page, PDF, '/?lang=he');
  await page.click('#addSign');
  await page.click('#tabType');
  // Hebrew interface: the Hebrew style is picked by default.
  await page.fill('#sigName', 'שי אפשטיין');
  // The Hebrew styles are offered, Gveret Levin first.
  await expect(page.locator('.fontchip')).toHaveCount(4);
  expect(await page.locator('.fontchip').evaluateAll((cs) => cs.map((c) => c.title))).toEqual(['Gveret Levin', 'Playpen Sans Hebrew', 'Amatic SC', 'Solitreo']);
  await expect(page.locator('.fontchip[aria-pressed="true"]')).toHaveAttribute('title', 'Gveret Levin');
  // Each one's own Hebrew letters load (no fallback).
  for (const family of ['Pared Playpen', 'Pared Amatic', 'Pared Solitreo']) {
    await expect.poll(() => page.evaluate((f) => document.fonts.check(`20px "${f}"`, 'שי'), family)).toBe(true);
  }
  await page.click('#sigUse');
  await expect(page.locator('.sig')).toHaveCount(1);
  expect(await page.evaluate(() => document.fonts.check('20px "Pared Gveret"', 'שי'))).toBe(true);

  await page.selectOption('#lang', 'ar');
  await typeSignature(page, 'ليلى', 'Aref Ruqaa');
  expect(await page.evaluate(() => document.fonts.check('20px "Pared Ruqaa"', 'ليلى'))).toBe(true);
  await expect(page.locator('.sig')).toHaveCount(2);
});

test('typing a signature works offline', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service worker offline mode is checked in Chromium');
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await typeSignature(page, 'Ada', 'Dancing Script');
  expect(await page.evaluate(() => document.fonts.check('20px "Pared Dancing"', 'Ada'))).toBe(true);
});

/* ---------- hidden details ---------- */

const infoOf = (bytes) => {
  const info = new mupdf.PDFDocument(bytes).getTrailer().get('Info');
  return info.isDictionary() ? info.resolve().asJS() : {};
};

test('says what hidden details a PDF has, and removes them on export', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'with-author.pdf'));
  await expect(page.locator('#strip')).toBeChecked();
  await expect(page.locator('#stripHint')).toContainText('This PDF has: author “Ada Example”, made with Keynote, dates, where a photo was taken.', { timeout: 30_000 });
  const info = infoOf(await download(page));
  expect(info.Author).toBeUndefined();
  expect(info.Creator).toBeUndefined();
  expect(info.CreationDate).toBeUndefined();
  expect(info.Title).toBe('Deck');
});

test('keeps hidden details when asked to', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'with-author.pdf'));
  await page.uncheck('#strip');
  await expect(page.locator('#stripHint')).toContainText('Hidden details are kept as they are.');
  expect(infoOf(await download(page)).Author).toBe('Ada Example');
});

test('describes hidden details in Hebrew', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'with-author.pdf'), '/?lang=he');
  await expect(page.locator('#stripHint')).toContainText('בקובץ הזה יש: מחבר ״\u2068Ada Example\u2069״');
});

/* ---------- password-protected PDFs ---------- */

async function unlock(page, url = '/') {
  await page.goto(url);
  await page.setInputFiles('#file', path.join(FIXTURES, 'locked.pdf'));
  await expect(page.locator('#pwCard')).toBeVisible();
  await expect(page.locator('#pw')).toBeFocused();
}

test('asks for the password, explains a wrong one, then opens', async ({ page }) => {
  await unlock(page);
  await expect(page.locator('#pwText')).toContainText('protected with a password');
  await page.fill('#pw', 'nope');
  await page.press('#pw', 'Enter');
  await expect(page.locator('#pwText')).toHaveText("That password didn't work. Try again.");
  await page.fill('#pw', 'open');
  await page.click('#pwCard button[type="submit"]');
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#pwCard')).toBeHidden();
  await expect(page.locator('#confidence')).toHaveText('Exact');
  await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
  // Exported with the same protection by default.
  await expect(page.locator('#keepPw')).toBeChecked();
  const out = new mupdf.PDFDocument(await download(page));
  expect(out.needsPassword()).toBe(true);
  expect(out.authenticatePassword('open')).toBeTruthy();
});

test('can export a protected PDF without its password', async ({ page }) => {
  await unlock(page);
  await page.fill('#pw', 'open');
  await page.press('#pw', 'Enter');
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await page.uncheck('#keepPw');
  const out = new mupdf.PDFDocument(await download(page));
  expect(out.needsPassword()).toBe(false);
  expect(out.countPages()).toBe(3);
});

test('an ordinary PDF has no password option', async ({ page }) => {
  await load(page);
  await expect(page.locator('#keepPwRow')).toBeHidden();
  await expect(page.locator('#pwCard')).toBeHidden();
});

test('asks for the password in Arabic', async ({ page }) => {
  await unlock(page, '/?lang=ar');
  await expect(page.locator('#pwText')).toContainText('محمي بكلمة مرور');
});

/* ---------- several files: merge, one per file, split ---------- */

// Reads the stored (uncompressed) ZIPs Pared writes.
function unzip(buf) {
  const out = [], dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = 0; dv.getUint32(o, true) === 0x04034b50;) {
    const size = dv.getUint32(o + 18, true), n = dv.getUint16(o + 26, true), x = dv.getUint16(o + 28, true);
    const start = o + 30 + n + x;
    out.push({ name: new TextDecoder().decode(buf.subarray(o + 30, o + 30 + n)), bytes: buf.subarray(start, start + size) });
    o = start + size;
  }
  return out;
}

const PHOTOS = path.join(FIXTURES, 'photos.pdf');
async function loadTwo(page, url = '/') {
  await page.goto(url);
  await page.setInputFiles('#file', [PDF, PHOTOS]);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
}
const pageCount = (bytes) => new mupdf.PDFDocument(bytes).countPages();

test('opens several PDFs as one, and saves one PDF per file', async ({ page }) => {
  await loadTwo(page);
  await expect(page.locator('#fname')).toHaveText('2 files');
  await expect(page.locator('#selCount')).toHaveText('9 of 9 selected');
  await expect(page.locator('.tfile')).toHaveText(['letterboxed.pdf', 'photos.pdf']);
  await expect(page.locator('#outMode')).toHaveValue('files');
  await expect(page.locator('#download')).toHaveText('Download ZIP · 2 PDFs');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  expect(dl.suggestedFilename()).toBe('letterboxed_200ppi.zip');
  const parts = unzip(fs.readFileSync(await dl.path()));
  expect(parts.map((p) => p.name)).toEqual(['letterboxed_200ppi.pdf', 'photos_200ppi.pdf']);
  expect(parts.map((p) => pageCount(p.bytes))).toEqual([6, 3]);
  await expect(page.locator('.result')).toContainText('(2 PDFs)');
});

test('merges several PDFs into one, in the chosen page order', async ({ page }) => {
  await loadTwo(page);
  await page.selectOption('#outMode', 'one');
  await expect(page.locator('#download')).toHaveText('Download PDF · 9 pages');
  // Put the photos file's first page first.
  await page.locator('.thumb[data-p="7"] .tdrag').focus();
  for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowLeft');
  expect(await gridOrder(page)).toEqual([7, 1, 2, 3, 4, 5, 6, 8, 9]);
  const bytes = await download(page);
  expect(pageCount(bytes)).toBe(9);
  // The first page is the photos page, then the 334.7 pt wide slides.
  const widths = summarise(bytes).pages.map(([x0, , x1]) => Math.round(x1 - x0));
  expect(widths[0]).not.toBe(335);
  expect(widths.slice(1, 7)).toEqual([335, 335, 335, 335, 335, 335]);
});

test('splits into parts of a chosen size', async ({ page }) => {
  await load(page);
  // Only one file, so "one PDF per file" isn't offered.
  await expect(page.locator('#outMode option[value="files"]')).toHaveAttribute('disabled', '');
  await page.selectOption('#outMode', 'every');
  await page.fill('#everyN', '4');
  await expect(page.locator('#download')).toHaveText('Download ZIP · 2 PDFs');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const parts = unzip(fs.readFileSync(await dl.path()));
  expect(parts.map((p) => p.name)).toEqual(['letterboxed_p1-4_200ppi.pdf', 'letterboxed_p5-6_200ppi.pdf']);
  expect(parts.map((p) => pageCount(p.bytes))).toEqual([4, 2]);
  expect(parts.map((p) => summarise(p.bytes).order)).toEqual([[1, 2, 3, 4], [5, 6]]);
});

test('asks for the password of the protected file among several', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('#file', [PHOTOS, path.join(FIXTURES, 'locked.pdf')]);
  await expect(page.locator('#pwText')).toContainText('“locked.pdf” is protected');
  await page.fill('#pw', 'open');
  await page.press('#pw', 'Enter');
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#selCount')).toHaveText('6 of 6 selected');
  await page.selectOption('#outMode', 'one');
  const out = new mupdf.PDFDocument(await download(page));
  expect(out.needsPassword()).toBe(true);
  expect(out.authenticatePassword('open')).toBeTruthy();
  expect(out.countPages()).toBe(6);
});

test('shows the hidden details, and which ones the export removes', async ({ page }) => {
  await load(page, path.join(FIXTURES, 'with-author.pdf'));
  const details = page.locator('#metaDetails');
  await expect(details.locator('summary')).toHaveText("Show what's hidden");
  await details.locator('summary').click();
  const row = (label) => details.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
  await expect(row('Author')).toHaveText('Ada Example removed');
  await expect(row('Title')).toHaveText('Deck kept');
  await expect(row('Made with')).toHaveText('Keynote removed');
  await expect(row('Created')).toContainText('2026');
  // The photo's camera, time and place, read from inside the JPEG.
  await expect(row('Photo 1')).toHaveText('Apple iPhone 15 Pro · taken 12 Mar 2026, 14:02 · at 32.08000, 34.78111 · edited with 17.4 removed', { timeout: 30_000 });
  await page.uncheck('#strip');
  await expect(row('Author')).toHaveText('Ada Example kept');
  await expect(row('Photo 1')).toContainText('kept');
});

test('no hidden details panel when there is nothing to show', async ({ page }) => {
  await load(page);
  await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
  await expect(page.locator('#metaDetails')).toBeHidden();
});

/* ---------- turned pages in the preview ---------- */

async function turnFirstPage(page) {
  await load(page);
  const before = await page.locator('#stageBox').boundingBox();
  await page.click('.thumb[data-p="1"] .trot');
  await expect(page.locator('#rotBadge')).toBeVisible();
  // The preview turns: the box around it takes the turned shape.
  await expect.poll(async () => {
    const b = await page.locator('#stageBox').boundingBox();
    return b.width > b.height !== before.width > before.height;
  }).toBe(true);
}

test('the preview shows a page turned as it will be exported', async ({ page }) => {
  await turnFirstPage(page);
  await expect(page.locator('#stage')).toHaveCSS('transform', /matrix\(/);
  // The badge stays upright, outside the turned page.
  expect(await page.locator('#rotBadge').evaluate((b) => b.closest('#stage'))).toBeNull();
});

test('dragging the crop on a turned page follows the finger', async ({ page }) => {
  await turnFirstPage(page);
  const size = async () => (await page.locator('#rSize').textContent()).match(/([\d.]+) × ([\d.]+)/).slice(1).map(Number);
  const [w0, h0] = await size();
  // Turned a quarter clockwise, the page's top edge shows on the right.
  await page.locator('#stageBox').scrollIntoViewIfNeeded();
  const top = await page.locator('.h[data-h="n"]').boundingBox();
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + top.width / 2 - 60, top.y + top.height / 2, { steps: 6 });
  await page.mouse.up();
  const [w1, h1] = await size();
  expect(w1).toBeCloseTo(w0, 0);
  expect(h1).toBeLessThan(h0 - 20); // moved inward: the page got shorter
});

test('a signature placed on a turned page reads upright there, and in the export', async ({ page }) => {
  await turnFirstPage(page);
  await page.click('#addSign');
  await page.click('#tabType');
  await page.fill('#sigName', 'Ada Lovelace');
  await page.click('#sigUse');
  // Wide on screen, as a name is, though the page underneath is turned.
  const shown = await page.locator('.sig img').boundingBox();
  expect(shown.width).toBeGreaterThan(shown.height * 2);
  await expect(page.locator('.sig img')).toHaveCSS('transform', /matrix/);
  // In the PDF's own coordinates the box is tall: it's drawn across the turned page.
  const [p0] = signatures(await download(page));
  const [x0, y0, x1, y1] = p0.rects[0];
  expect(y1 - y0).toBeGreaterThan((x1 - x0) * 2);
});

/* ---------- updates of the installed app ---------- */

// The test server serves the site under /t/<name>/ as if deployed at the
// version last set here (sw.js stamped as the deploy job does). The
// browser's own update checks for sw.js reach the server, not test routes.
const deployAs = (request, name, version) => request.post(`/deploy/${name}/${version}`);
const appCaches = (page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('pared-app-')).sort());
const checkForUpdate = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
async function installed(page, request, name, version) {
  await deployAs(request, name, version);
  await page.goto(`/t/${name}/`);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  // A returning visit: the page starts on this version, as an installed app does.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  expect(await appCaches(page)).toEqual([`pared-app-${version}`]);
}

test('on the start screen, a new version takes over by itself', async ({ page, context, request, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'service worker updates are checked in Chromium');
  const name = `start-${info.project.name}`;
  await installed(page, request, name, 'aaaaaaa11111');
  await page.evaluate(() => { window.beforeUpdate = true; });
  await deployAs(request, name, 'bbbbbbb22222');
  await checkForUpdate(page);
  // The page reloaded into the new version, and the old copy is gone.
  await page.waitForFunction(() => !window.beforeUpdate, null, { timeout: 15_000 });
  await expect.poll(() => appCaches(page)).toEqual(['pared-app-bbbbbbb22222']);
  // And it works offline from the new copy.
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#drop')).toBeVisible();
  await context.setOffline(false);
});

test('with a file open, a new version waits for "Reload"', async ({ page, request, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'service worker updates are checked in Chromium');
  const name = `open-${info.project.name}`;
  await installed(page, request, name, 'aaaaaaa11111');
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => { window.beforeUpdate = true; });
  await deployAs(request, name, 'ccccccc33333');
  await checkForUpdate(page);
  await expect(page.locator('#updateBar')).toBeVisible({ timeout: 15_000 });
  // Nothing changed under the open file: same page, still on the old copy.
  expect(await page.evaluate(() => window.beforeUpdate)).toBe(true);
  await expect(page.locator('#exportCard')).toBeVisible();
  // Files the open page fetches now still come from its own version, though
  // the server has moved on: old and new never mix.
  const servedVersion = () => page.evaluate(async () => (await (await fetch('pages.js')).text()).match(/deployed (\w+)/)?.[1]);
  expect(await servedVersion()).toBe('aaaaaaa11111');
  await page.click('#updateBtn');
  await page.waitForFunction(() => !window.beforeUpdate, null, { timeout: 15_000 });
  await expect.poll(() => appCaches(page)).toEqual(['pared-app-ccccccc33333']);
  await expect(page.locator('#updateBar')).toBeHidden();
  expect(await servedVersion()).toBe('ccccccc33333');
});

/* ---------- signatures on thumbnails ---------- */

test('thumbnails show signatures where they sit, and follow changes', async ({ page }) => {
  await load(page);
  await drawSignature(page);
  const thumbSig = page.locator('.thumb[data-p="1"] .tsig');
  await expect(thumbSig).toHaveCount(1);
  await expect(thumbSig).toHaveAttribute('src', /^data:image\/png/);
  await expect(page.locator('.thumb[data-p="2"] .tsig')).toHaveCount(0);
  // Same place on the thumbnail as in the preview, relative to the page.
  const where = async (sig, frame) => {
    const s = await page.locator(sig).boundingBox(), f = await page.locator(frame).boundingBox();
    return [(s.x + s.width / 2 - f.x) / f.width, (s.y + s.height / 2 - f.y) / f.height];
  };
  const big = await where('.sig', '#crop'), small = await where('.thumb[data-p="1"] .tsig', '.thumb[data-p="1"] .tclip');
  expect(Math.abs(big[0] - small[0])).toBeLessThan(0.05);
  expect(Math.abs(big[1] - small[1])).toBeLessThan(0.05);
  // Moving it moves the thumbnail's copy.
  const before = await thumbSig.boundingBox();
  await page.locator('.sig').focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await thumbSig.boundingBox()).y).toBeGreaterThan(before.y + 2);
  // Removing it removes the copy.
  await page.keyboard.press('Delete');
  await expect(thumbSig).toHaveCount(0);
});

test('on a turned page, the thumbnail shows the signature upright too', async ({ page }) => {
  await load(page);
  await page.click('.thumb[data-p="1"] .trot');
  await page.click('#addSign');
  await page.click('#tabType');
  await page.fill('#sigName', 'Ada Lovelace');
  await page.click('#sigUse');
  const b = await page.locator('.thumb[data-p="1"] .tsig').boundingBox();
  expect(b.width).toBeGreaterThan(b.height * 2); // wide, like the name, on screen
});

test('a first visit never reloads by itself', async ({ page, request }, info) => {
  // The first install takes control at once; it must not be taken for an
  // update (WebKit reports it as installed late, which used to reload).
  const name = `first-${info.project.name}`;
  await deployAs(request, name, 'ddddddd44444');
  await page.goto(`/t/${name}/`);
  await page.evaluate(() => { window.firstLoad = true; });
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.firstLoad)).toBe(true);
  await expect(page.locator('#updateBar')).toBeHidden();
});

/* ---------- saved signatures ---------- */

async function typeAndRemember(page, name, remember) {
  await page.click('#addSign');
  await page.click('#tabType');
  await page.fill('#sigName', name);
  if (remember) await page.check('#sigRemember');
  await page.click('#sigUse');
  await expect(page.locator('#signDlg')).toBeHidden();
}

test('remembers a signature on this device, and adds it with one tap next time', async ({ page }) => {
  await load(page);
  await expect(page.locator('#savedSigs')).toBeHidden();
  await expect(page.locator('#sigRemember')).not.toBeChecked(); // opt-in
  await typeAndRemember(page, 'Ada Lovelace', true);
  await expect(page.locator('.saved-sig')).toHaveCount(1);

  // A new visit, a new document: one tap signs it.
  await load(page, path.join(FIXTURES, 'photos.pdf'));
  await expect(page.locator('#savedSigs')).toBeVisible();
  await expect(page.locator('.saved-sig img')).toHaveAttribute('src', /^data:image\/png/);
  await page.click('.saved-sig');
  await expect(page.locator('.sig')).toHaveCount(1);
  expect(signatures(await download(page))[0].rects).toHaveLength(1);
});

test('keeps at most four, newest first, without repeats, and forgets on request', async ({ page }) => {
  await load(page);
  for (const name of ['One', 'Two', 'Three', 'Two', 'Four', 'Five']) await typeAndRemember(page, name, true);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('pared-signatures')).map((x) => x.sig.text));
  expect(await saved()).toEqual(['Five', 'Four', 'Two', 'Three']);
  await expect(page.locator('.saved-sig')).toHaveCount(4);
  await page.click('.saved-item:first-child .saved-forget');
  await expect(page.locator('.saved-sig')).toHaveCount(3);
  expect(await saved()).toEqual(['Four', 'Two', 'Three']);
});

test('without "Remember", nothing is stored', async ({ page }) => {
  await load(page);
  await typeAndRemember(page, 'Ada', false);
  await expect(page.locator('.sig')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('pared-signatures'))).toBeNull();
  await expect(page.locator('#savedSigs')).toBeHidden();
});

test('saved signatures speak the chosen language', async ({ page }) => {
  await load(page, PDF, '/?lang=he');
  await typeAndRemember(page, 'שי', true);
  await page.reload();
  await expect(page.locator('.saved-sig')).toHaveAttribute('aria-label', 'הוספת חתימה שמורה 1 לעמוד הזה');
});

/* ---------- date, initials, every page ---------- */

test('adds today’s date in one tap, in the interface language', async ({ page }) => {
  await load(page);
  await page.click('#addDate');
  await expect(page.locator('.sig')).toHaveCount(1);
  const today = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date());
  await expect(page.locator('.sig')).toHaveAttribute('aria-label', new RegExp(`^${today}\\. Signature`));
  expect(signatures(await download(page))[0].rects).toHaveLength(1);
});

test('the date is written in Hebrew in the Hebrew interface', async ({ page }) => {
  await load(page, PDF, '/?lang=he');
  await page.click('#addDate');
  const today = new Intl.DateTimeFormat('he-IL', { dateStyle: 'medium' }).format(new Date());
  await expect(page.locator('.sig')).toHaveAttribute('aria-label', new RegExp(`^${today}\\.`));
  expect(await page.evaluate(() => document.fonts.check('20px "Pared Gveret"', 'נוב'))).toBe(true);
});

test('initials start from the typed name, small, and can go on every page', async ({ page }) => {
  await load(page);
  await typeAndRemember(page, 'Ada Lovelace', false);
  await page.click('#addInitials');
  await expect(page.locator('#signDlgTitle')).toHaveText('Your initials');
  await expect(page.locator('#sigName')).toHaveValue('A.L.');
  await page.click('#sigUse');
  await expect(page.locator('.sig')).toHaveCount(2);
  const [sigBox, initBox] = await Promise.all([page.locator('.sig').nth(0).boundingBox(), page.locator('.sig').nth(1).boundingBox()]);
  expect(initBox.width).toBeLessThan(sigBox.width * 0.6);

  // The initials are selected: put them on every page (5 more), once.
  await expect(page.locator('#copyAll')).toBeVisible();
  await page.click('#copyAll');
  await expect(page.locator('#copyDone')).toHaveText('Added to 5 more pages.');
  await page.locator('.sig').nth(1).focus();
  await page.click('#copyAll');
  await expect(page.locator('#copyDone')).toHaveText('It’s already on every page.');
  for (const p of [2, 6]) await expect(page.locator(`.thumb[data-p="${p}"] .tsig`)).toHaveCount(1);

  const pages = signatures(await download(page));
  expect(pages.map((p) => p.rects.length)).toEqual([2, 1, 1, 1, 1, 1]);
  // Same spot on every page (the pages are alike).
  const r = pages.map((p) => p.rects.at(-1).map((v) => Math.round(v)));
  expect(new Set(r.map(String)).size).toBe(1);
});

test('copies skip pages that are not exported', async ({ page }) => {
  await load(page);
  await page.fill('#range', '1-3');
  await page.press('#range', 'Enter');
  await page.click('#addDate');
  await page.click('#copyAll');
  await expect(page.locator('#copyDone')).toHaveText('Added to 2 more pages.');
});

test('a full name typed for initials becomes initials', async ({ page }) => {
  await load(page);
  await page.click('#addInitials');
  await expect(page.locator('#sigName')).toHaveValue(''); // no name known yet
  await expect(page.locator('#typeHint')).toHaveText('Type your name or your initials.');
  await page.fill('#sigName', 'Shai Epstein');
  await expect(page.locator('.fontchip').first()).toHaveText('S.E.'); // previewed as initials
  await page.click('#sigUse');
  await expect(page.locator('.sig')).toHaveAttribute('aria-label', /^S\.E\.\. /);
  // Typed as initials already: kept exactly.
  await page.click('#addInitials');
  await page.fill('#sigName', 'SE');
  await page.click('#sigUse');
  await expect(page.locator('.sig').nth(1)).toHaveAttribute('aria-label', /^SE\. /);
});

test('initials come from a name typed for the signature, even if cancelled', async ({ page }) => {
  await load(page);
  await page.click('#addSign');
  await page.click('#tabType');
  await page.fill('#sigName', 'Ada Lovelace');
  await page.click('#sigCancel');
  await page.click('#addInitials');
  await expect(page.locator('#sigName')).toHaveValue('A.L.');
});

test('"Add a signature" opens where it was left, not on the initials tab', async ({ page }) => {
  await load(page);
  await page.click('#addSign');
  await expect(page.locator('#tabDraw')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#sigCancel');
  await page.click('#addInitials');
  await expect(page.locator('#tabType')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#sigCancel');
  await page.click('#addSign');
  await expect(page.locator('#tabDraw')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#signDlgTitle')).toHaveText('Your signature');
  await expect(page.locator('#typeHint')).toHaveText('Type your name and pick a style.');
});

/* ---------- undo and redo ---------- */

const settle = (page) => page.waitForTimeout(500); // a step is recorded once changes settle

test('undo and redo crop changes, one step at a time', async ({ page }) => {
  await load(page);
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#redo')).toBeDisabled();
  await page.click('.chip:has-text("Whole sheet")');
  await settle(page);
  await page.click('.chip:has-text("4:5")');
  await settle(page);
  await expect(page.locator('#rSize')).not.toHaveText('842 × 595 pt');
  await page.click('#undo');
  await expect(page.locator('#rSize')).toHaveText('842 × 595 pt');
  await page.click('#undo');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
  await expect(page.locator('.chip[aria-pressed="true"]')).toHaveText('Auto (9:16)');
  await expect(page.locator('#undo')).toBeDisabled();
  await page.click('#redo');
  await expect(page.locator('#rSize')).toHaveText('842 × 595 pt');
});

test('a whole crop drag is one step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await load(page);
  const h = await page.locator('.h[data-h="n"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 4; k++) { await page.mouse.move(h.x + h.width / 2, h.y + 20 * k, { steps: 3 }); await page.waitForTimeout(450); } // pauses mid-drag
  await page.mouse.up();
  await settle(page);
  await page.click('#undo');
  await expect(page.locator('#rSize')).toHaveText('334.7 × 595 pt');
  await expect(page.locator('#undo')).toBeDisabled();
});

test('undo and redo signatures, and the export follows', async ({ page }) => {
  await load(page);
  await page.click('#addDate');
  await settle(page);
  // Where the signature sits on the page, independent of scrolling.
  const at = async () => { const b = await page.locator('.sig').boundingBox(), st = await page.locator('#stage').boundingBox(); return b.y - st.y; };
  await page.locator('.sig').focus();
  await page.keyboard.press('Shift+ArrowDown');
  await settle(page);
  const moved = await at();
  await page.click('#undo'); // the move
  expect(await at()).toBeLessThan(moved - 5);
  await page.click('#undo'); // the date itself
  await expect(page.locator('.sig')).toHaveCount(0);
  await expect(page.locator('.thumb[data-p="1"] .tsig')).toHaveCount(0);
  expect(signatures(await download(page))[0].rects).toHaveLength(0);
  await page.click('#redo');
  await page.click('#redo');
  await expect(page.locator('.sig')).toHaveCount(1);
  expect(await at()).toBeCloseTo(moved, 0);
  expect(signatures(await download(page))[0].rects).toHaveLength(1);
});

test('undo rotation, page order and page selection, with the keyboard', async ({ page }) => {
  await load(page);
  await page.click('.thumb[data-p="2"] .trot');
  await settle(page);
  await page.locator('.thumb[data-p="1"] .tdrag').focus();
  await page.keyboard.press('ArrowRight');
  await settle(page);
  await page.locator('.thumb[data-p="3"] input[type="checkbox"]').uncheck();
  await settle(page);
  await expect(page.locator('#selCount')).toHaveText('5 of 6 selected');
  await page.locator('#prev').focus();
  await page.keyboard.press('Control+z');
  await expect(page.locator('#selCount')).toHaveText('6 of 6 selected');
  await page.keyboard.press('Control+z');
  expect(await gridOrder(page)).toEqual([1, 2, 3, 4, 5, 6]);
  await page.keyboard.press('Control+z');
  const { rotate } = summarise(await download(page));
  expect(rotate).toEqual([0, 0, 0, 0, 0, 0]);
  await page.keyboard.press('Control+Shift+z');
  expect(summarise(await download(page)).rotate).toEqual([0, 90, 0, 0, 0, 0]);
});

test('typing in a text box keeps its own undo', async ({ page }) => {
  await load(page);
  await page.click('.chip:has-text("Whole sheet")');
  await settle(page);
  await page.fill('#range', '1-3');
  await page.press('#range', 'Control+z');
  // The crop wasn't undone by the text box's undo.
  await expect(page.locator('#rSize')).toHaveText('842 × 595 pt');
});

test('on a turned page, the signature buttons stay top-right and bottom-right, and resizing grows from the other corner', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse drag');
  await load(page);
  for (let turns = 1; turns <= 3; turns++) {
    await page.click('.thumb[data-p="1"] .trot');
    await page.click('#addDate');
    const sig = page.locator('.sig').last();
    await page.locator('#stageBox').scrollIntoViewIfNeeded();
    const s = await sig.boundingBox(), del = await sig.locator('.sig-del').boundingBox(), rs = await sig.locator('.sig-rs').boundingBox();
    // × at the top-right of the signature as shown, resize at the bottom-right.
    expect(del.x + del.width / 2).toBeGreaterThan(s.x + s.width - 5);
    expect(del.y + del.height / 2).toBeLessThan(s.y + 5);
    expect(rs.x + rs.width / 2).toBeGreaterThan(s.x + s.width - 5);
    expect(rs.y + rs.height / 2).toBeGreaterThan(s.y + s.height - 5);
    // Drag the resize handle outward: the top-left corner stays where it was.
    await page.mouse.move(rs.x + rs.width / 2, rs.y + rs.height / 2);
    await page.mouse.down();
    await page.mouse.move(rs.x + rs.width / 2 + 40, rs.y + rs.height / 2 + 15, { steps: 5 });
    await page.mouse.up();
    const after = await sig.boundingBox();
    expect(after.width).toBeGreaterThan(s.width + 15);
    expect(Math.abs(after.x - s.x)).toBeLessThan(3);
    expect(Math.abs(after.y - s.y)).toBeLessThan(3);
    await page.keyboard.press('Delete');
  }
});
