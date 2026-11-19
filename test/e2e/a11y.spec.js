// Accessibility checks with axe, on each screen, in a left-to-right and a
// right-to-left language.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { FIXTURES } from './make-fixtures.js';

const PDF = path.join(FIXTURES, 'letterboxed.pdf');

async function audit(page, what) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const report = violations.map((v) => `${what}: ${v.id} (${v.impact}) ${v.help}\n${v.nodes.slice(0, 4).map((n) => `   ${n.target.join(' ')}: ${n.failureSummary.split('\n')[1]?.trim()}`).join('\n')}`);
  expect(report, report.join('\n\n')).toEqual([]);
}

for (const lang of ['en', 'ar']) {
  test(`start screen is accessible (${lang})`, async ({ page }) => {
    await page.goto(`/?lang=${lang}`);
    await audit(page, 'start');
  });

  test(`working screen is accessible (${lang})`, async ({ page }) => {
    await page.goto(`/?lang=${lang}`);
    await page.setInputFiles('#file', PDF);
    await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
    await audit(page, 'work');
  });

  test(`signature dialog and a placed signature are accessible (${lang})`, async ({ page }) => {
    await page.goto(`/?lang=${lang}`);
    await page.setInputFiles('#file', PDF);
    await expect(page.locator('#exportCard')).toBeVisible({ timeout: 60_000 });
    await page.click('#addSign');
    await audit(page, 'dialog/draw');
    await page.click('#tabType');
    await page.fill('#sigName', 'Ada');
    await audit(page, 'dialog/type');
    await page.click('#sigUse');
    await expect(page.locator('.sig')).toHaveCount(1);
    await audit(page, 'placed');
  });
}

for (const scheme of ['light', 'dark']) {
  test(`warnings and errors are readable (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/?lang=he');
    await page.setInputFiles('#file', path.join(FIXTURES, 'signed.pdf'));
    await expect(page.locator('#sigWarn')).toBeVisible({ timeout: 30_000 });
    await page.fill('#range', '9-1');
    await page.press('#range', 'Enter');
    await expect(page.locator('#rangeErr')).toBeVisible();
    await audit(page, `warnings/${scheme}`);
  });
}

test('working screen is accessible in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#estimate')).toContainText('≈', { timeout: 30_000 });
  await audit(page, 'work/dark');
  await page.click('#addSign');
  await audit(page, 'dialog/dark');
});

test('password prompt is accessible', async ({ page }) => {
  await page.goto('/?lang=he');
  await page.setInputFiles('#file', path.join(FIXTURES, 'locked.pdf'));
  await expect(page.locator('#pwCard')).toBeVisible();
  await audit(page, 'password');
});

test('saved signatures are accessible', async ({ page }) => {
  await page.goto('/?lang=ar');
  await page.evaluate(() => localStorage.setItem('pared-signatures', JSON.stringify([{ id: 's1', sig: { kind: 'draw', strokes: [[0, 0.5, 0.5, 0.2, 1, 0.8]], width: 0.05, aspect: 3, color: '#1b1b1f' } }])));
  await page.reload(); // as on a return visit
  await page.setInputFiles('#file', PDF);
  await expect(page.locator('#savedSigs')).toBeVisible({ timeout: 60_000 });
  await audit(page, 'saved');
});
