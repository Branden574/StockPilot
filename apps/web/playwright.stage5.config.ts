import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { defineConfig, devices, type Project } from '@playwright/test';

import {
  assertLocal,
  isRole,
  ROLES,
  storageStateFor,
  type Role,
} from './tests/e2e/appearance/stage5-env';

/**
 * Playwright config for the Liquid Glass STAGE 5 lab run
 * (IMPLEMENTATION-PLAN.md section 8; liquid-glass/verify/stage5/RUNBOOK.md).
 * Run only by liquid-glass/verify/stage5/run-stage5.sh against `next start`
 * servers on 127.0.0.1: there is no webServer, and the config refuses any
 * base URL that is not 127.0.0.1 or localhost (PLAYWRIGHT_BASE_URL and
 * STAGE5_BASE_URL_B), so it can never reach a deployment.
 *
 * Projects:
 *  - setup-<role> (admin, manager, staff, viewer, platform, portal): signs the
 *    role in (stage5.auth.ts) into tests/e2e/.auth/stage5-<role>.json. The
 *    file is NOT named *.setup.ts: the default playwright.config.ts setup
 *    project takes every such file under tests/e2e, and this one would fail
 *    there and stop `pnpm test:e2e` (src/test/stage5-config-isolation.test.ts);
 *  - chrome: every appearance spec as STAGE5_ROLE (default manager), Google
 *    Chrome through channel 'chrome' (Chrome 156 is installed; Playwright
 *    1.64.1's own Chromium build 1248 may not be);
 *  - webkit, firefox: the same, only when the browser revision this
 *    @playwright/test wants is installed (otherwise the project is absent and
 *    the runner records the gap);
 *  - anonymous: Chrome with no session (signed-out site and auth checks),
 *    stage 5 specs only (PRE_STAGE5 below);
 *  - phone-390: Chrome at 390 x 844 as STAGE5_ROLE, stage 5 specs only;
 *  - perf: tests/perf/appearance.perf.ts (8.4), Chrome, one worker.
 *
 * Env (the cross-writer interface): PLAYWRIGHT_BASE_URL (the build under
 * test), STAGE5_BASE_URL_B (classic at the merge base, headers/network
 * specs), STAGE5_ROLE, STAGE5_ROLLOUT, STAGE5_PHASE, STAGE5_STATE_DIR; lab
 * credentials only from env (stage5-env.ts).
 */

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3400';
assertLocal({ PLAYWRIGHT_BASE_URL: BASE_URL, STAGE5_BASE_URL_B: process.env.STAGE5_BASE_URL_B });

const roleEnv = process.env.STAGE5_ROLE ?? 'manager';
if (!isRole(roleEnv)) throw new Error(`STAGE5_ROLE must be one of ${ROLES.join(', ')}`);
const ROLE: Role = roleEnv;

/** True when the browser revision this Playwright wants is on disk. */
function installed(browser: 'webkit' | 'firefox'): boolean {
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    const pw = dirname(req.resolve('@playwright/test/package.json'));
    const core = dirname(
      createRequire(
        join(
          dirname(createRequire(join(pw, 'package.json')).resolve('playwright/package.json')),
          'package.json',
        ),
      ).resolve('playwright-core/package.json'),
    );
    const list = JSON.parse(readFileSync(join(core, 'browsers.json'), 'utf8')) as {
      browsers: { name: string; revision: string }[];
    };
    const rev = list.browsers.find((b) => b.name === browser)?.revision;
    if (!rev) return false;
    const root =
      process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
        ? process.env.PLAYWRIGHT_BROWSERS_PATH
        : join(homedir(), 'Library', 'Caches', 'ms-playwright');
    return existsSync(join(root, `${browser}-${rev}`));
  } catch {
    return false;
  }
}

const setupProjects: Project[] = ROLES.map((role) => ({
  name: `setup-${role}`,
  testMatch: /stage5\.auth\.ts/u,
  metadata: { role },
  use: { ...devices['Desktop Chrome'], channel: 'chrome' },
}));

const signedIn = storageStateFor(ROLE);
const SPECS = /.*\.spec\.ts/u;
/**
 * The specs written before stage 5 (stages 3 and 4): each sets its own
 * viewport and, when it is signed out, its own empty session, so they run in
 * the engine projects only. The anonymous and phone-390 projects run the
 * stage 5 specs, which skip (with the reason) wherever they do not apply.
 */
const PRE_STAGE5 =
  /(admin-actions|admin-transitions|fidelity-small|header-menu-name|insights-identity|insights-transitions|item-detail-composition|items-identity|items-transitions|metadata-equality|ops-actions|ops-transitions|orders-identity|orders-transitions|phone-layouts|site-menu|site-transitions|twin-rewrite-cache|twin-structure|variant-guard)\.spec\.ts$/u;

const engineProjects: Project[] = [
  {
    name: 'chrome',
    testMatch: SPECS,
    use: { ...devices['Desktop Chrome'], channel: 'chrome', storageState: signedIn },
    dependencies: [`setup-${ROLE}`],
  },
];
if (installed('webkit'))
  engineProjects.push({
    name: 'webkit',
    testMatch: SPECS,
    use: { ...devices['Desktop Safari'], storageState: signedIn },
    dependencies: [`setup-${ROLE}`],
  });
if (installed('firefox'))
  engineProjects.push({
    name: 'firefox',
    testMatch: SPECS,
    use: { ...devices['Desktop Firefox'], storageState: signedIn },
    dependencies: [`setup-${ROLE}`],
  });

export default defineConfig({
  testDir: './tests/e2e/appearance',
  outputDir: './test-results/stage5',
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.STAGE5_REPORT ?? 'test-results/stage5/report.json' }],
  ],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // Traces and videos would write lab record names to disk; failures keep a screenshot only.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    ...setupProjects,
    ...engineProjects,
    {
      name: 'anonymous',
      testMatch: SPECS,
      testIgnore: PRE_STAGE5,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: 'phone-390',
      testMatch: SPECS,
      testIgnore: PRE_STAGE5,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 390, height: 844 },
        storageState: signedIn,
      },
      dependencies: [`setup-${ROLE}`],
    },
    {
      name: 'perf',
      testDir: './tests/perf',
      testMatch: /appearance\.perf\.ts/u,
      timeout: 60 * 60_000,
      use: { ...devices['Desktop Chrome'], channel: 'chrome', storageState: signedIn },
      dependencies: [`setup-${ROLE}`],
    },
  ],
});
