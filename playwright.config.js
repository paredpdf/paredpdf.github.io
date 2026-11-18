import { defineConfig, devices } from '@playwright/test';

// Set PARED_CHROMIUM to use an installed Chromium instead of Playwright's
// own download. Firefox and WebKit come from `npm run browsers`, which keeps
// them in .browsers/ inside the project.
const executablePath = process.env.PARED_CHROMIUM || undefined;
const chromium = { launchOptions: { executablePath } };

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/make-fixtures.js',
  timeout: 120_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8790',
    acceptDownloads: true,
  },
  webServer: {
    command: 'node test/e2e/server.js',
    url: 'http://127.0.0.1:8790/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...chromium, viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], ...chromium } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 900 } } },
    // Safari's engine. Needs Ubuntu's libraries, so it runs in CI.
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
});
