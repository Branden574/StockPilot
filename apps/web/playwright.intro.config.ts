import { defineConfig, devices } from '@playwright/test';

/**
 * Cross-browser config for the landing-intro spec only.
 *
 * The main config runs chromium behind an authenticated setup project; the
 * landing is anonymous, and the intro is exactly the kind of code that breaks
 * differently per engine (clip-path, mask-image, rAF timing), so this config
 * runs the one spec on chromium + webkit + firefox with no auth dependency.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 \
 *     pnpm exec playwright test -c playwright.intro.config.ts
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /landing-intro\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    // The prod build sends upgrade-insecure-requests + HSTS. WebKit honours
    // them even for localhost (Chromium/Firefox exempt it as trustworthy), so
    // Safari can only be exercised through the local https proxy with its
    // self-signed cert. See scripts in the session scratchpad / CI docs.
    ignoreHTTPSErrors: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
