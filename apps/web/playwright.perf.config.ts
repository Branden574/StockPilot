import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the PERFORMANCE harness (tests/perf). Deliberately
 * separate from playwright.config.ts so a timing run never joins the default
 * e2e run, and so its settings can be hostile to everything that distorts a
 * measurement or writes customer data to disk:
 *
 *   - one worker, no retries: a retried sample is a cherry-picked sample;
 *   - trace / video / screenshot OFF: tracing costs time, and all three would
 *     write signed image URLs (30-day bearer credentials) to disk;
 *   - the FAILURE SNAPSHOT is off too. Playwright writes `error-context.md` for
 *     any failed test: an ARIA dump of the open page, which here means item
 *     names, SKUs, ids, the signed-in user and the value of every input. It has
 *     no config switch, only the env var set below;
 *   - action and navigation timeouts, so a covered link becomes one recorded
 *     failed sample in seconds, not a 30-minute hang with a page left open;
 *   - no webServer: the target is whatever PERF_BASE_URL names. Measure a
 *     production BUILD (`next build && next start`, a preview, or production),
 *     never `next dev`: dev has no prefetch and no minification.
 *
 * See tests/perf/README.md for sign-in modes, scenarios and output.
 */
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const BROWSERS = {
  chromium: devices['Desktop Chrome'],
  webkit: devices['Desktop Safari'],
  firefox: devices['Desktop Firefox'],
} as const;
const requested = process.env.PERF_BROWSER ?? 'chromium';
if (!(requested in BROWSERS))
  throw new Error(`PERF_BROWSER must be one of ${Object.keys(BROWSERS).join(', ')}`);
const BROWSER = requested as keyof typeof BROWSERS;

const viewportMatch = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.PERF_VIEWPORT ?? '1440x900');
if (!viewportMatch) throw new Error('PERF_VIEWPORT must look like 1440x900');
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };

export default defineConfig({
  testDir: './tests/perf',
  testMatch: /.*\.perf\.ts/,
  // Its own scratch folder: Playwright empties outputDir at the start of a run,
  // and sharing test-results/ with the e2e suite would wipe that suite's output.
  outputDir: './perf-results/.playwright-output',
  preserveOutput: 'never',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: 'list',
  // A scenario is N iterations of real navigations; the ceiling is per scenario.
  timeout: 30 * 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: process.env.PERF_BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, teardown: 'teardown' },
    // Signs the saved session out and deletes it, even when the run failed.
    { name: 'teardown', testMatch: /auth\.teardown\.ts/ },
    {
      // `pnpm perf`. The browser is chosen with PERF_BROWSER so a results
      // folder always names exactly one engine.
      name: 'run',
      testMatch: /run\.perf\.ts/,
      use: { ...BROWSERS[BROWSER], viewport, deviceScaleFactor: Number(process.env.PERF_DPR ?? 2) },
      dependencies: ['setup'],
    },
    // `pnpm perf:compare`. No browser, no sign-in: it only reads results folders.
    { name: 'compare', testMatch: /compare\.perf\.ts/ },
  ],
});
