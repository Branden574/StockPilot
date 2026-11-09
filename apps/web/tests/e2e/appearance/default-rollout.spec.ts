import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { chooseLook, settle, settleIntroNotice, START, waitForLook } from './look';
import { buildRollout, MARKETING_PATHS, twinOnScreen, type Rollout } from './site-look';
import {
  attributeHistory,
  contextWithLook,
  deviceSnapshot,
  isChromium,
  labSql,
  labUser,
  onlyOnceAcrossRoles,
  readState,
  recordAttributeHistory,
  removeAppearanceRow,
  requireEnv,
  signedOutContext,
  signIn,
  stage5Phase,
  startScreencast,
  statePath,
  watchSaves,
  writeState,
} from './stage5a-lib';
import { DEVICE_LOCAL_KEYS, REHEARSAL_ORDER, rehearsalFileNames } from './stage5a-records';

/**
 * PROVES plan 8.2 case 12 (R5, R13, R15), the default rollout, on the lab:
 *
 *  1. NO COOKIE: a visitor with no Design cookie and no stored choice sees
 *     glass on the 7 marketing pages, the auth pages and, signed in as a
 *     person who never chose (lab user A, row removed), the dashboard; the
 *     head script sets the glass attribute before any paint;
 *  2. LEGACY THEME: `theme=light` / `theme=dark` (next-themes' key, what
 *     every existing browser holds) gives Day / Night glass with NO WRITE:
 *     no Set-Cookie of sp_style, no Design cookie route call, no account
 *     save, and localStorage and the cookie jar unchanged;
 *  3. CLASSIC ON A HARD LOAD: sp_style=classic (with the matching device
 *     record and account) never shows a glass frame on /dashboard,
 *     /dashboard/inventory and /signin: the attribute's whole history from
 *     the document's start holds no glass value, and a CDP screencast of
 *     every frame is saved for the reviewer (Chromium); the marketing HTML
 *     served with that cookie is the classic page;
 *  4. THE INTRO NOTICE (R13) appears once for a person without a Design, and
 *     each of its buttons writes an explicit Design (device record, cookie,
 *     account save); after a reload it does not come back;
 *  5. THE REHEARSAL (STAGE5_PHASE=rehearsal-1 .. rehearsal-5, one build each:
 *     off, opt-in, default, opt-in, off): lab user A's profile is carried
 *     from build to build, each build's pages are opened and nothing is
 *     clicked; each step writes its device snapshot (rehearsal-<n>-<rollout>
 *     .json) and, with STAGE5_LAB_DB_URL, A's account row
 *     (account-row-<n>-<rollout>.txt: style, theme, updated_at) to
 *     STAGE5_STATE_DIR; rehearsal-compare.mjs then requires all five
 *     byte-identical.
 *
 * Cases 1, 2 and 4 run on the default build only; case 3 on opt-in and
 * default; case 5 only with STAGE5_PHASE. Cases 1 (signed in), 4 and 5 need
 * lab user A and the lab database (STAGE5_LAB_DB_URL, 127.0.0.1 only); run
 * with --workers=1, apart from other specs signing in as A.
 *
 * Lab commands:
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<default port> STAGE5_ROLE=admin \
 *     STAGE5_A_EMAIL=... STAGE5_A_PASSWORD=... STAGE5_LAB_DB_URL=postgresql://...@127.0.0.1:55422/postgres \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --workers=1 tests/e2e/appearance/default-rollout.spec.ts
 *   rehearsal, per build in order (the runner): add STAGE5_PHASE=rehearsal-<n> STAGE5_STATE_DIR=<dir>
 *   and PLAYWRIGHT_BASE_URL of that build; then
 *   node apps/web/tests/e2e/appearance/rehearsal-compare.mjs <dir>
 */

const INTRO = 'StockPilot has a new look. You can switch back to the classic design at any time.';
const AUTH_PATHS = ['/signin', '/signup', '/reset'];

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

const isRehearsal = () => /^rehearsal-\d$/u.test(stage5Phase() ?? '');

function onlyDefault(): void {
  test.skip(isRehearsal(), 'The rehearsal phase runs only the rehearsal.');
  onlyOnceAcrossRoles();
  test.skip(rollout !== 'default', `Default rollout only (this build: ${rollout}).`);
}

/** The head script set glass before anything else touched the attribute. */
function headScriptSetGlass(history: (string | null)[]): boolean {
  return history[0] === 'liquid-glass' || (history[0] === null && history[2] === 'liquid-glass');
}

test('1 no cookie: glass on the marketing pages, the auth pages and the dashboard of a person who never chose', async ({
  browser,
  baseURL,
}) => {
  onlyDefault();
  const context = await signedOutContext(browser, baseURL!);
  await recordAttributeHistory(context);
  const page = await context.newPage();
  for (const path of [...MARKETING_PATHS, ...AUTH_PATHS]) {
    await page.goto(path);
    await settle(page);
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('data-appearance')),
      `${path}: glass`,
    ).toBe('liquid-glass');
    if ((MARKETING_PATHS as readonly string[]).includes(path))
      expect(await twinOnScreen(page), `${path}: the glass twin`).toBe(true);
    expect(
      headScriptSetGlass(await attributeHistory(page)),
      `${path}: glass from the first paint`,
    ).toBe(true);
  }
  expect((await deviceSnapshot(page)).cookie, 'no cookie written').toBeNull();
  await context.close();

  const a = labUser('A');
  requireEnv('STAGE5_LAB_DB_URL');
  removeAppearanceRow(a.email);
  const signed = await signedOutContext(browser, baseURL!);
  await recordAttributeHistory(signed);
  const dash = await signed.newPage();
  await signIn(dash, a);
  await dash.goto('/dashboard/inventory');
  await expect(dash.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(dash);
  expect(
    headScriptSetGlass(await attributeHistory(dash)),
    'Items: glass from the first paint',
  ).toBe(true);
  expect(await dash.evaluate(() => document.documentElement.getAttribute('data-appearance'))).toBe(
    'liquid-glass',
  );
  await signed.close();
});

/** Every write a load could make to the person's appearance. */
function watchWrites(page: Page): () => string[] {
  const writes: string[] = [];
  page.on('response', async (response) => {
    const cookies = (await response.headersArray())
      .filter((h) => h.name.toLowerCase() === 'set-cookie' && /(?:^|\s)sp_style=/u.test(h.value))
      .map((h) => `Set-Cookie on ${response.url()}: ${h.value.split(';')[0]}`);
    writes.push(...cookies);
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/appearance/style')
      writes.push(`POST /api/appearance/style ${request.postData() ?? ''}`);
  });
  const saves = watchSaves(page);
  return () => [...writes, ...saves.list().map((s) => `account save ${JSON.stringify(s)}`)];
}

for (const theme of ['light', 'dark'] as const) {
  test(`2 legacy theme=${theme}: ${theme === 'light' ? 'Day' : 'Night'} glass, with no write`, async ({
    browser,
    baseURL,
  }) => {
    onlyDefault();
    const context = await browser.newContext({
      baseURL,
      storageState: {
        cookies: [],
        origins: [
          { origin: new URL(baseURL!).origin, localStorage: [{ name: 'theme', value: theme }] },
        ],
      },
    });
    const page = await context.newPage();
    const writes = watchWrites(page);
    for (const path of ['/signin', '/', '/pricing']) {
      await page.goto(path);
      await waitForLook(page, { design: 'liquid-glass', theme });
      await settle(page);
    }
    expect(writes(), 'no write of any kind').toEqual([]);
    const after = await deviceSnapshot(page);
    expect(after.cookie, 'no Design cookie').toBeNull();
    for (const key of DEVICE_LOCAL_KEYS) {
      expect(after.local[key], `localStorage ${key}`).toBe(key === 'theme' ? theme : null);
    }
    await context.close();
  });
}

test('3 sp_style=classic: no glass frame on a hard load (attribute history and a screencast), and the classic marketing HTML', async ({
  browser,
  baseURL,
  request,
}) => {
  test.skip(isRehearsal(), 'The rehearsal phase runs only the rehearsal.');
  test.skip(rollout === 'off', 'off: no glass to keep out.');
  test.skip(
    !process.env.STAGE5_ROLE ||
      ['anonymous', 'platform', 'portal'].includes(process.env.STAGE5_ROLE),
    'Needs an organisation member’s run.',
  );
  const context = await contextWithLook(browser, baseURL!, START, 'classic');
  // The account holds Classic too, so the account read adopts nothing.
  const first = await context.newPage();
  await first.goto('/dashboard/whats-new');
  await settleIntroNotice(first);
  await chooseLook(first, START);
  await settle(first);
  await first.close();

  await recordAttributeHistory(context);
  for (const path of ['/dashboard', '/dashboard/inventory']) {
    const page = await context.newPage();
    const cast = isChromium(page) ? await startScreencast(page) : null;
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await settle(page);
    const history = await attributeHistory(page);
    expect(history.includes('liquid-glass'), `${path}: ${history.join(' > ')}`).toBe(false);
    if (cast) {
      const frames = await cast.stop(
        test.info().outputPath('screencast'),
        path.replace(/\W+/gu, '_'),
      );
      expect(frames, `${path}: frames captured`).toBeGreaterThan(0);
    }
    await page.close();
  }
  await context.close();

  const visitor = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  await visitor.addCookies([{ name: 'sp_style', value: 'classic', url: baseURL! }]);
  await recordAttributeHistory(visitor);
  const signin = await visitor.newPage();
  const cast = isChromium(signin) ? await startScreencast(signin) : null;
  await signin.goto('/signin');
  await settle(signin);
  const history = await attributeHistory(signin);
  expect(history.includes('liquid-glass'), `/signin: ${history.join(' > ')}`).toBe(false);
  if (cast) await cast.stop(test.info().outputPath('screencast'), 'signin');
  await visitor.close();

  for (const path of MARKETING_PATHS) {
    const html = await (
      await request.get(path, { headers: { cookie: 'sp_style=classic' } })
    ).text();
    expect(html.includes('data-lg-twin'), `${path}: the classic page`).toBe(false);
  }
});

for (const button of ['Keep Liquid Glass', 'Use classic design'] as const) {
  test(`4 the intro notice appears once; "${button}" writes an explicit Design`, async ({
    browser,
    baseURL,
  }) => {
    onlyDefault();
    const a = labUser('A');
    requireEnv('STAGE5_LAB_DB_URL');
    removeAppearanceRow(a.email);
    const context = await signedOutContext(browser, baseURL!);
    const page = await context.newPage();
    const saves = watchSaves(page);
    await signIn(page, a);
    await expect(page.getByText(INTRO)).toHaveCount(1, { timeout: 15_000 });
    await page.getByRole('button', { name: button }).click();
    const design = button === 'Keep Liquid Glass' ? 'liquid-glass' : 'classic';
    await expect.poll(() => saves.list().some((s) => s.style === design)).toBe(true);
    const records = await deviceSnapshot(page);
    expect(JSON.parse(records.local['sp-appearance'] ?? 'null')).toMatchObject({ style: design });
    expect(records.local['sp-lg-intro-seen']).not.toBeNull();
    await expect.poll(async () => (await deviceSnapshot(page)).cookie).toBe(design);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await settle(page);
    await expect(page.getByText(INTRO), 'not again after a reload').toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.getAttribute('data-appearance')),
    ).toBe(design === 'liquid-glass' ? 'liquid-glass' : null);
    await context.close();
  });
}

test('5 rehearsal step: open the pages, click nothing, write the device snapshot and the account row', async ({
  browser,
  baseURL,
}) => {
  test.skip(!isRehearsal(), 'Runs only with STAGE5_PHASE=rehearsal-<n>.');
  onlyOnceAcrossRoles();
  const step = Number(stage5Phase()!.slice('rehearsal-'.length));
  const expected = REHEARSAL_ORDER[step - 1];
  expect(expected, `rehearsal step ${step} of ${REHEARSAL_ORDER.length}`).toBeDefined();
  expect(rollout, `step ${step} runs on the ${expected} build`).toBe(expected);
  const names = rehearsalFileNames(step);
  const a = labUser('A');
  const profileName = 'rehearsal-profile.json';
  const origin = new URL(baseURL!).origin;

  let context: BrowserContext;
  if (step === 1) {
    context = await browser.newContext({
      baseURL,
      storageState: {
        cookies: [],
        origins: [{ origin, localStorage: [{ name: 'theme', value: 'dark' }] }],
      },
    });
    await signIn(await context.newPage(), a);
  } else {
    const saved = readState(profileName);
    if (saved === null) throw new Error('rehearsal-profile.json is missing: run step 1 first.');
    const state = JSON.parse(saved) as {
      cookies: never[];
      origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };
    context = await browser.newContext({
      baseURL,
      storageState: {
        cookies: state.cookies,
        origins: state.origins.slice(0, 1).map((o) => ({ origin, localStorage: o.localStorage })),
      },
    });
  }
  const page = await context.newPage();
  for (const path of ['/dashboard', '/dashboard/inventory', '/dashboard/orders', '/']) {
    await page.goto(path);
    await settle(page);
  }
  writeState(names.device, await deviceSnapshot(page));
  if (process.env.STAGE5_LAB_DB_URL) {
    writeState(
      names.row,
      labSql(
        `select coalesce(a.style,'') || '|' || coalesce(a.theme,'') || '|' || a.updated_at::text ` +
          `from public.user_appearance a join auth.users u on u.id = a.user_id ` +
          `where lower(u.email) = lower('${a.email.replace(/'/gu, "''")}')`,
      ),
    );
  }
  await context.storageState({ path: statePath(profileName) });
  await context.close();
});
