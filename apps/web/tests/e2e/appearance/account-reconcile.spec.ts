import { expect, test, type Browser, type Page, type Request } from '@playwright/test';

import { chooseLook, settle, settleIntroNotice, waitForLook, type Look } from './look';
import { buildRollout, type Rollout } from './site-look';
import {
  appearanceRow,
  delaySaves,
  deviceSnapshot,
  failSaves,
  labUser,
  onlyOnceAcrossRoles,
  removeAppearanceRow,
  requireEnv,
  signedOutContext,
  signIn,
  signOut,
  submitSignIn,
  watchSaves,
  type LabUser,
} from './stage5a-lib';

/**
 * PROVES plan 8.2 case 5 on the lab, in a real browser (the reducer's rules
 * are unit-proven in packages/core/src/appearance/reconcile.test.ts; this
 * file proves the web wiring end to end; malformed AsyncStorage is native):
 *
 *  1. account switch: A signs out and B signs in on the same tab; B gets
 *     B's own account look, never A's, and nothing of A's is saved to B;
 *  2. organisation switch: the look and the account row do not change and
 *     nothing is saved;
 *  3. SR4 fresh: a choice on /signin, then signing in in the same tab within
 *     30 minutes: a null account axis takes it (saved), a set one wins;
 *  4. SR4 31 minutes later (page.clock): never pushed;
 *  5. SR4 from another tab: never pushed;
 *  6. echo: a Theme saved on this device adopts the Design another device
 *     saved (round 2 finding 6);
 *  7. a first-ever choice whose save failed, then a reload: pushed, because
 *     the row is null (round 2 finding 13);
 *  8. a malformed cookie, and malformed localStorage: the rollout's default
 *     shows, nothing breaks, and the next choice writes valid records;
 *  9. a missing row: the rollout's default, nothing saved;
 * 10. a save held 5 s, then a second choice: both apply at once, the saves go
 *     one at a time in order, and the row ends with both;
 * 11. a failed save (500), then Try again: the status line says so, Try again
 *     saves, the row holds the choice;
 * 12. a late account read (held 5 s) never overwrites a choice made while it
 *     was in flight.
 *
 * LAB ONLY, once per build (the admin run), opt-in or default (skips in
 * `off`). Needs lab users A and B (one organisation; A in two organisations
 * for case 2) and the lab database (cases 3, 4, 5, 7, 9 remove A's
 * user_appearance row; labSql refuses any host but 127.0.0.1/localhost).
 * Every case changes A's account row: run this file with --workers=1, apart
 * from every other spec that signs in as A.
 *
 * Lab command:
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     STAGE5_A_EMAIL=... STAGE5_A_PASSWORD=... STAGE5_B_EMAIL=... STAGE5_B_PASSWORD=... \
 *     STAGE5_LAB_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --workers=1 \
 *     tests/e2e/appearance/account-reconcile.spec.ts
 */

test.use({ storageState: { cookies: [], origins: [] } });

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});
test.beforeEach(() => {
  onlyOnceAcrossRoles();
  test.skip(rollout === 'off', 'off: Liquid Glass is not offered, nothing is reconciled.');
});

const NIGHT: Look = { design: 'liquid-glass', theme: 'dark' };
const DAY: Look = { design: 'liquid-glass', theme: 'light' };
const CLASSIC_DARK: Look = { design: 'classic', theme: 'dark' };
const CLASSIC_LIGHT: Look = { design: 'classic', theme: 'light' };
const DEFAULT_DESIGN = () => (rollout === 'default' ? 'liquid-glass' : 'classic');

const PROFILE = '/dashboard/settings/profile';
const STATUS_SYNCED = 'Saved to your account.';
const STATUS_FAILED = 'Saved on this device. Not saved to your account yet.';

/** A fresh browser (context) where `user` signs in through /signin. */
async function signedIn(browser: Browser, baseURL: string, user: LabUser, path = PROFILE) {
  const context = await signedOutContext(browser, baseURL);
  const page = await context.newPage();
  const saves = watchSaves(page);
  await signIn(page, user);
  if (path !== '/dashboard') await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settleIntroNotice(page);
  await settle(page);
  return { context, page, saves };
}

/** Sets `user`'s account row to `look` through the header menu of a separate browser. */
async function setAccountLook(browser: Browser, baseURL: string, user: LabUser, look: Look) {
  const { context, page, saves } = await signedIn(browser, baseURL, user);
  // Move both axes away first, so both are saved whatever the row held.
  await chooseLook(page, {
    design: look.design === 'classic' ? 'liquid-glass' : 'classic',
    theme: look.theme === 'dark' ? 'light' : 'dark',
  });
  await chooseLook(page, look);
  await expect(page.getByText(STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  expect(saves.list().length).toBeGreaterThan(0);
  await context.close();
}

/** The status line of the appearance panel (/dashboard/settings/profile). */
const status = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Chooses `look` on /signin (signed out) through its header menu. */
async function chooseSignedOut(page: Page, look: Look) {
  await page.goto('/signin');
  await expect(page.getByLabel(/email/iu)).toBeVisible();
  await chooseLook(page, look);
}

test('1 account switch: B signs in after A on the same tab and gets B’s own look; nothing of A’s reaches B', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  const b = labUser('B');
  await setAccountLook(browser, baseURL!, b, CLASSIC_DARK);
  await setAccountLook(browser, baseURL!, a, DAY);

  const { context, page, saves } = await signedIn(browser, baseURL!, a);
  await waitForLook(page, DAY);
  saves.reset();
  await signOut(page);
  await page.goto('/signin');
  await submitSignIn(page, b);
  await page.goto(PROFILE);
  await waitForLook(page, CLASSIC_DARK);
  await settle(page);
  expect(
    saves.list().filter((s) => s.style !== undefined || s.theme !== undefined),
    'no save on B’s account at sign-in (B’s row decides)',
  ).toEqual([]);
  await context.close();

  // A's account still holds Day glass.
  const again = await signedIn(browser, baseURL!, a);
  await waitForLook(again.page, DAY);
  await again.context.close();
});

test('2 organisation switch: the look stays, nothing is saved', async ({ browser, baseURL }) => {
  const a = labUser('A');
  const { context, page, saves } = await signedIn(browser, baseURL!, a, '/dashboard');
  await chooseLook(page, NIGHT);
  await settle(page);
  const switcher = page.getByRole('button', { name: 'Switch organization' });
  if (!(await switcher.isVisible().catch(() => false)))
    test.skip(true, 'Lab user A belongs to one organisation only.');
  const activeName = (await switcher.locator('[data-glass="ws-name"]').innerText()).trim();
  saves.reset();
  await switcher.click();
  const other = page.getByRole('menuitem').filter({ hasNotText: activeName });
  if ((await other.count()) === 0) test.skip(true, 'No other organisation to switch to.');
  await other.first().click();
  await expect(switcher.locator('[data-glass="ws-name"]')).not.toHaveText(activeName, {
    timeout: 20_000,
  });
  await settle(page);
  await waitForLook(page, NIGHT);
  expect(saves.list(), 'no save on an organisation switch').toEqual([]);
  // Back to the organisation A started in, for every later spec.
  await switcher.click();
  await page.getByRole('menuitem').filter({ hasText: activeName }).first().click();
  await expect(switcher.locator('[data-glass="ws-name"]')).toHaveText(activeName, {
    timeout: 20_000,
  });
  await context.close();
});

test('3 SR4 fresh: a choice on /signin reaches a null account axis at sign-in in the same tab; a set axis wins', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');

  // A null row: the signed-out choice is saved.
  removeAppearanceRow(a.email);
  let context = await signedOutContext(browser, baseURL!);
  let page = await context.newPage();
  let saves = watchSaves(page);
  await chooseSignedOut(page, NIGHT);
  await submitSignIn(page, a);
  await waitForLook(page, NIGHT);
  await expect
    .poll(() => saves.list().some((s) => s.style === 'liquid-glass' && s.theme === 'dark'))
    .toBe(true);
  await expect.poll(() => appearanceRow(a.email)).toBe('liquid-glass|dark');
  await context.close();

  // A set row: the row wins, nothing is pushed.
  await setAccountLook(browser, baseURL!, a, CLASSIC_LIGHT);
  context = await signedOutContext(browser, baseURL!);
  page = await context.newPage();
  saves = watchSaves(page);
  await chooseSignedOut(page, NIGHT);
  await submitSignIn(page, a);
  await waitForLook(page, CLASSIC_LIGHT);
  await settle(page);
  expect(saves.list(), 'the row won: nothing pushed').toEqual([]);
  expect(appearanceRow(a.email)).toBe('classic|light');
  await context.close();
});

test('4 SR4 after 31 minutes (page.clock): the signed-out choice is never pushed', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');
  removeAppearanceRow(a.email);
  const context = await signedOutContext(browser, baseURL!);
  const page = await context.newPage();
  await page.clock.install();
  const saves = watchSaves(page);
  await chooseSignedOut(page, NIGHT);
  await page.clock.fastForward('31:00');
  await submitSignIn(page, a);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
  expect(saves.list(), 'a 31-minute-old choice is not offered to the account').toEqual([]);
  expect(appearanceRow(a.email), 'the row stays absent').toBeNull();
  await context.close();
});

test('5 SR4 from another tab: a choice made in one tab never reaches the account signed in from another', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');
  removeAppearanceRow(a.email);
  const context = await signedOutContext(browser, baseURL!);
  const chooser = await context.newPage();
  await chooseSignedOut(chooser, NIGHT);
  const page = await context.newPage();
  const saves = watchSaves(page);
  await page.goto('/signin');
  await submitSignIn(page, a);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
  expect(saves.list(), 'nothing pushed from another tab’s choice').toEqual([]);
  expect(appearanceRow(a.email), 'the row stays absent').toBeNull();
  await context.close();
});

test('6 echo: a Theme saved here adopts the Design another device saved', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  await setAccountLook(browser, baseURL!, a, CLASSIC_DARK);
  const here = await signedIn(browser, baseURL!, a);
  await waitForLook(here.page, CLASSIC_DARK);

  // Another device chooses Liquid Glass (its own browser, its own save).
  const there = await signedIn(browser, baseURL!, a);
  await chooseLook(there.page, NIGHT);
  await expect(there.page.getByText(STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  await there.context.close();

  here.saves.reset();
  await chooseLook(here.page, CLASSIC_LIGHT);
  await expect.poll(() => here.saves.list().length).toBeGreaterThan(0);
  expect(here.saves.list()[0], 'this device sent only the Theme').toEqual({
    userId: here.saves.list()[0]!.userId,
    theme: 'light',
  });
  await waitForLook(here.page, DAY);
  await here.context.close();
});

test('7 a first-ever choice whose save failed, then a reload: pushed, because the row is null', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');
  removeAppearanceRow(a.email);
  const { context, page, saves } = await signedIn(browser, baseURL!, a);
  let failing = true;
  const refused = await failSaves(page, () => failing);
  await chooseLook(page, {
    design: DEFAULT_DESIGN() === 'classic' ? 'liquid-glass' : 'classic',
    theme: 'dark',
  });
  const chosen = await page.evaluate(() =>
    document.documentElement.getAttribute('data-appearance') === 'liquid-glass'
      ? 'liquid-glass'
      : 'classic',
  );
  await expect(status(page, STATUS_FAILED)).toBeVisible({ timeout: 15_000 });
  expect(refused.failed()).toBeGreaterThan(0);
  expect(appearanceRow(a.email), 'nothing reached the account').toBeNull();

  failing = false;
  saves.reset();
  await page.reload();
  await expect
    .poll(() => saves.list().some((s) => s.style === chosen), {
      message: 'the dirty Design is pushed after the reload',
    })
    .toBe(true);
  await expect.poll(() => appearanceRow(a.email)?.split('|')[0]).toBe(chosen);
  await expect(status(page, STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  await context.close();
});

for (const broken of ['cookie', 'localStorage'] as const) {
  test(`8 a malformed ${broken}: the rollout's default shows, nothing breaks, and the next choice writes valid records`, async ({
    browser,
    baseURL,
  }) => {
    const context = await signedOutContext(browser, baseURL!);
    if (broken === 'cookie') {
      await context.addCookies([
        { name: 'sp_style', value: '%E0%A4%A{not-a-design', url: baseURL! },
      ]);
    } else {
      await context.addInitScript(() => {
        if (sessionStorage.getItem('lab-seeded')) return;
        sessionStorage.setItem('lab-seeded', '1');
        localStorage.setItem('sp-appearance', '{"v":2,"style":"neon"');
        localStorage.setItem('sp-appearance-sync', '[]');
      });
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/signin');
    await expect(page.getByLabel(/email/iu)).toBeVisible();
    await settle(page);
    const glass = await page.evaluate(
      () => document.documentElement.getAttribute('data-appearance') === 'liquid-glass',
    );
    expect(glass ? 'liquid-glass' : 'classic', 'the rollout’s default').toBe(DEFAULT_DESIGN());
    await expect(page.getByText(/Something broke|Something went wrong/u)).toHaveCount(0);
    expect(errors, 'no uncaught error').toEqual([]);

    await chooseLook(page, NIGHT);
    const device = await deviceSnapshot(page);
    expect(JSON.parse(device.local['sp-appearance'] ?? 'null')).toMatchObject({
      v: 2,
      style: 'liquid-glass',
    });
    await expect.poll(async () => (await deviceSnapshot(page)).cookie).toBe('liquid-glass');
    await page.reload();
    await waitForLook(page, NIGHT);
    await context.close();
  });
}

test('9 a missing row: the rollout’s default shows and nothing is saved', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');
  removeAppearanceRow(a.email);
  const { context, page, saves } = await signedIn(browser, baseURL!, a);
  const glass = await page.evaluate(
    () => document.documentElement.getAttribute('data-appearance') === 'liquid-glass',
  );
  expect(glass ? 'liquid-glass' : 'classic').toBe(DEFAULT_DESIGN());
  await settle(page);
  expect(saves.list(), 'nothing saved for a person who never chose').toEqual([]);
  expect(appearanceRow(a.email)).toBeNull();
  await context.close();
});

test('10 a save held 5 s, then a second choice: both apply at once and the saves go one at a time, in order', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  await setAccountLook(browser, baseURL!, a, CLASSIC_DARK);
  const { context, page } = await signedIn(browser, baseURL!, a);
  const sent: { body: string; at: number }[] = [];
  const answered: number[] = [];
  page.on('request', (request: Request) => {
    if (
      request.method() === 'POST' &&
      request.headers()['next-action'] &&
      request.postData()?.includes('"userId"')
    )
      sent.push({ body: request.postData() ?? '', at: Date.now() });
  });
  page.on('requestfinished', (request: Request) => {
    if (
      request.method() === 'POST' &&
      request.headers()['next-action'] &&
      request.postData()?.includes('"userId"')
    )
      answered.push(Date.now());
  });
  await delaySaves(page, 5000);
  await chooseLook(page, NIGHT);
  await chooseLook(page, DAY);
  await waitForLook(page, DAY);
  await expect.poll(() => answered.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  expect(sent.length, 'one save per choice').toBe(2);
  expect(sent[0]!.body).toContain('"style":"liquid-glass"');
  expect(sent[1]!.body).toContain('"theme":"light"');
  expect(
    sent[1]!.at,
    'the second save left only after the first was answered',
  ).toBeGreaterThanOrEqual(answered[0]! - 50);
  await expect(page.getByText(STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  if (process.env.STAGE5_LAB_DB_URL) expect(appearanceRow(a.email)).toBe('liquid-glass|light');
  await context.close();
});

test('11 a failed save (500), then Try again: the status line says so and Try again saves', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  await setAccountLook(browser, baseURL!, a, CLASSIC_DARK);
  const { context, page, saves } = await signedIn(browser, baseURL!, a);
  let failing = true;
  const refused = await failSaves(page, () => failing);
  await chooseLook(page, NIGHT);
  await expect(status(page, STATUS_FAILED)).toBeVisible({ timeout: 15_000 });
  expect(refused.failed()).toBeGreaterThan(0);
  await waitForLook(page, NIGHT);

  failing = false;
  saves.reset();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(status(page, STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  expect(saves.list().some((s) => s.style === 'liquid-glass')).toBe(true);
  if (process.env.STAGE5_LAB_DB_URL) expect(appearanceRow(a.email)).toBe('liquid-glass|dark');
  await context.close();
});

/** The account read: a server action whose one argument is a user id. */
function isAccountRead(request: Request): boolean {
  if (request.method() !== 'POST' || !request.headers()['next-action']) return false;
  try {
    const args = JSON.parse(request.postData() ?? '') as unknown;
    return (
      Array.isArray(args) &&
      args.length === 1 &&
      typeof args[0] === 'string' &&
      /^[0-9a-f-]{36}$/iu.test(args[0])
    );
  } catch {
    return false;
  }
}

test('12 a late account read never overwrites a choice made while it was in flight', async ({
  browser,
  baseURL,
}) => {
  const a = labUser('A');
  await setAccountLook(browser, baseURL!, a, CLASSIC_LIGHT);
  const context = await signedOutContext(browser, baseURL!);
  const page = await context.newPage();
  await signIn(page, a);
  await page.goto(PROFILE);
  await waitForLook(page, CLASSIC_LIGHT);
  await settle(page);

  let held = 0;
  await page.route('**/*', async (route) => {
    if (isAccountRead(route.request())) {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await chooseLook(page, NIGHT);
  await expect.poll(() => held, { message: 'the account read was held' }).toBeGreaterThan(0);
  await page.waitForTimeout(6000);
  await settle(page);
  await waitForLook(page, NIGHT);
  await expect(page.getByText(STATUS_SYNCED)).toBeVisible({ timeout: 15_000 });
  if (process.env.STAGE5_LAB_DB_URL) expect(appearanceRow(a.email)).toBe('liquid-glass|dark');
  await context.close();
});
