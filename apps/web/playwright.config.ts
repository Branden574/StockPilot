import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for StockPilot E2E.
 *
 * Run against either:
 *   • A local dev server (`pnpm dev` on apps/web → http://localhost:3000)
 *   • A Vercel preview URL via PLAYWRIGHT_BASE_URL env
 *
 * Auth is handled per-test via the storageState path written by the
 * `auth.setup.ts` setup project. Set TEST_USER_EMAIL +
 * TEST_USER_PASSWORD env vars to point at a real Supabase test account.
 *
 * Headless by default; `pnpm test:e2e:ui` opens the time-travel UI.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],

  // Auto-start the local dev server unless we're pointed elsewhere.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm dev',
        port: 3000,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
