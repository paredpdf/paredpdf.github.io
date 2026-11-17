import { defineConfig, devices } from '@playwright/test';

// Set PARED_CHROMIUM to use an installed Chromium instead of Playwright's
// own download (handy locally; CI runs `npx playwright install chromium`).
const executablePath = process.env.PARED_CHROMIUM || undefined;

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/make-fixtures.js',
  timeout: 120_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8790',
    acceptDownloads: true,
    launchOptions: { executablePath },
  },
  webServer: {
    command: 'node test/e2e/server.js',
    url: 'http://127.0.0.1:8790/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
