import { readFileSync } from 'node:fs';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { chooseLook, settle, settleIntroNotice, waitForLook, type Look } from './look';
import { buildRollout, twinOnScreen } from './site-look';
import {
  deviceSnapshot,
  readState,
  stage5Phase,
  stage5Role,
  statePath,
  writeState,
} from './stage5a-lib';
import {
  comparedPart,
  DEVICE_LOCAL_KEYS,
  KILL_PHASES,
  killDoneFileName,
  phaseProblem,
  snapshotDifferences,
  STYLE_COOKIE,
  type DeviceSnapshot,
} from './stage5a-records';

/**
 * PROVES plan 8.2 case 11 (D12, R5), across builds: a build with the flag
 * off and a glass cookie and stored value gives classic everywhere, and
 * turning the flag back on restores glass without the person choosing
 * again. One browser profile is carried from build to build in
 * STAGE5_STATE_DIR (Playwright storage state: cookies and localStorage).
 *
 * Three phases, one per build, in this order (the runner sets STAGE5_PHASE
 * and starts the matching build):
 *   kill-record  (opt-in or default build) the run's role chooses Liquid
 *                Glass Night through the header menu (an explicit choice);
 *                the profile and its device records are saved;
 *   kill-off     (off build) with that profile: the dashboard, Items and
 *                the marketing pages are classic (no glass attribute, no
 *                twin, the header menu without a Design group), and the
 *                device records are byte-identical to what was saved;
 *   kill-back    (the opt-in or default build again) with the profile the
 *                off build left: Night glass on the dashboard and the glass
 *                landing, with no choice made, and the device records still
 *                byte-identical.
 * Without STAGE5_PHASE every test skips; with a phase name it does not know
 * (anything but the three above and the rehearsal's rehearsal-1..5) every
 * test FAILS. Each phase writes kill-switch-<phase>-done.json to
 * STAGE5_STATE_DIR as its last step, only when all its checks passed, and
 * kill-switch-compare.mjs <STAGE5_STATE_DIR> (after kill-back) requires all
 * three: a phase that skipped (for example a role it does not run as:
 * anonymous, platform, portal) cannot read as passed. Any organisation role
 * (admin, manager, staff, viewer) may run it.
 *
 * Lab commands (run-stage5.sh, in order, one build each):
 *   cd apps/web && STAGE5_STATE_DIR=<dir> STAGE5_ROLE=admin PLAYWRIGHT_BASE_URL=http://127.0.0.1:<default port> \
 *     STAGE5_PHASE=kill-record pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/kill-switch.spec.ts
 *   ... PLAYWRIGHT_BASE_URL=http://127.0.0.1:<off port> STAGE5_PHASE=kill-off ...
 *   ... PLAYWRIGHT_BASE_URL=http://127.0.0.1:<default port> STAGE5_PHASE=kill-back ...
 *   node apps/web/tests/e2e/appearance/kill-switch-compare.mjs <dir>
 */

const NIGHT: Look = { design: 'liquid-glass', theme: 'dark' };
const STATE = 'kill-switch-profile.json';
const STATE_AFTER_OFF = 'kill-switch-profile-after-off.json';
const RECORD = 'kill-switch-device.json';

const ROUTES = ['/dashboard', '/dashboard/inventory', '/dashboard/whats-new'];
const MARKETING = ['/', '/pricing', '/security'];

interface SavedState {
  cookies: Array<{ name: string } & Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/**
 * The saved profile for this build's server. Each build runs on its own port,
 * and localStorage belongs to an origin (port included) while cookies do not,
 * so the saved localStorage is moved to this server's origin. With
 * `appearanceOnly`, only the appearance records are kept: a signed-out
 * visitor of the marketing pages.
 */
function profileFor(name: string, baseURL: string, appearanceOnly = false): SavedState {
  const state = JSON.parse(readFileSync(statePath(name), 'utf8')) as SavedState;
  const origin = new URL(baseURL).origin;
  const keys = new Set<string>(DEVICE_LOCAL_KEYS);
  return {
    cookies: appearanceOnly ? state.cookies.filter((c) => c.name === STYLE_COOKIE) : state.cookies,
    origins: state.origins.slice(0, 1).map((o) => ({
      origin,
      localStorage: appearanceOnly
        ? o.localStorage.filter((item) => keys.has(item.name))
        : o.localStorage,
    })),
  };
}

function recorded(): DeviceSnapshot {
  const text = readState(RECORD);
  if (text === null) throw new Error(`${RECORD} is missing: run the kill-record phase first.`);
  return JSON.parse(text) as DeviceSnapshot;
}

async function expectRecordsKept(page: Page, where: string): Promise<void> {
  const now = await deviceSnapshot(page);
  expect(snapshotDifferences(recorded(), now), `device records ${where}`).toEqual([]);
  expect(comparedPart(now)).toBe(comparedPart(recorded()));
}

async function marketingVisitor(browser: Browser, baseURL: string, profile: string) {
  return browser.newContext({ baseURL, storageState: profileFor(profile, baseURL, true) as never });
}

test.beforeEach(() => {
  // A phase name this spec does not know FAILS: skipping every test would
  // exit 0 and read as a pass (run-stage5.sh once named them record,
  // check-off and check-on).
  const problem = phaseProblem(stage5Phase());
  if (problem) throw new Error(problem);
  test.skip(
    !(KILL_PHASES as readonly string[]).includes(stage5Phase() ?? ''),
    'Phased across builds: the runner sets STAGE5_PHASE (kill-record, kill-off, kill-back).',
  );
  test.skip(
    ['platform', 'portal', null].includes(stage5Role()),
    'Runs in an organisation member’s run (admin).',
  );
});

test('kill-record: an explicit Liquid Glass Night choice, saved with the profile', async ({
  page,
  request,
}) => {
  test.skip(stage5Phase() !== 'kill-record', 'Another phase.');
  expect(await buildRollout(request), 'kill-record runs on a build offering Liquid Glass').not.toBe(
    'off',
  );
  await page.goto('/dashboard/whats-new');
  await settleIntroNotice(page);
  await chooseLook(page, { design: 'classic', theme: 'dark' });
  await chooseLook(page, NIGHT);
  await settle(page);
  const snapshot = await deviceSnapshot(page);
  expect(snapshot.cookie).toBe('liquid-glass');
  writeState(RECORD, snapshot);
  await page.context().storageState({ path: statePath(STATE) });
  writeState(killDoneFileName('kill-record'), { phase: 'kill-record', passed: true });
});

test('kill-off: the off build shows classic everywhere and touches no stored value', async ({
  browser,
  baseURL,
  request,
}) => {
  test.skip(stage5Phase() !== 'kill-off', 'Another phase.');
  expect(await buildRollout(request), 'kill-off runs on the off build').toBe('off');
  const context = await browser.newContext({
    baseURL,
    storageState: profileFor(STATE, baseURL!) as never,
  });
  const page = await context.newPage();
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await settle(page);
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('data-appearance')),
      `${route}: no glass attribute`,
    ).toBeNull();
    await page.locator('#theme-toggle-trigger').first().click();
    await expect(page.getByRole('menuitemradio', { name: 'Liquid Glass' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectRecordsKept(page, `after ${route} on the off build`);
  }
  await context.storageState({ path: statePath(STATE_AFTER_OFF) });
  await context.close();

  const visitor = await marketingVisitor(browser, baseURL!, STATE);
  const site = await visitor.newPage();
  for (const path of MARKETING) {
    await site.goto(path);
    await settle(site);
    expect(await twinOnScreen(site), `${path}: the classic page`).toBe(false);
    expect(
      await site.evaluate(() => document.documentElement.getAttribute('data-appearance')),
      `${path}: no glass attribute`,
    ).toBeNull();
  }
  await visitor.close();
  writeState(killDoneFileName('kill-off'), { phase: 'kill-off', passed: true });
});

test('kill-back: the flag back on restores Night glass with no choice made', async ({
  browser,
  baseURL,
  request,
}) => {
  test.skip(stage5Phase() !== 'kill-back', 'Another phase.');
  expect(await buildRollout(request), 'kill-back runs on a build offering Liquid Glass').not.toBe(
    'off',
  );
  const context = await browser.newContext({
    baseURL,
    storageState: profileFor(STATE_AFTER_OFF, baseURL!) as never,
  });
  const page = await context.newPage();
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await waitForLook(page, NIGHT);
    await settle(page);
    await expectRecordsKept(page, `after ${route} with the flag back on`);
  }
  await context.close();

  const visitor = await marketingVisitor(browser, baseURL!, STATE_AFTER_OFF);
  const site = await visitor.newPage();
  for (const path of MARKETING) {
    await site.goto(path);
    await settle(site);
    expect(await twinOnScreen(site), `${path}: the glass twin`).toBe(true);
    await waitForLook(site, NIGHT);
  }
  await visitor.close();
  writeState(killDoneFileName('kill-back'), { phase: 'kill-back', passed: true });
});
