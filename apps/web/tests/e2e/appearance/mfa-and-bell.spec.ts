import { expect, test, type Page } from '@playwright/test';

import { chooseLook, glassBuild, settle, settleIntroNotice, waitForLook, type Look } from './look';
import { arriveWith, buildRollout, cookieFor } from './site-look';
import {
  attributeHistory,
  bellCount,
  freshTotp,
  labUser,
  linkPaths,
  onlyOnceAcrossRoles,
  recordAttributeHistory,
  recordRequests,
  signedOutContext,
  signIn,
  stage5Role,
} from './stage5a-lib';
import { neverClassicAfterGlass } from './stage5a-paint';
import { compareLoads } from './stage5a-network';

/**
 * PROVES plan 8.2 case 6 on the web (the push tap is native,
 * verify/stage5/native):
 *
 *  - SIGN-IN WITH MFA IN GLASS: a lab user with a verified TOTP factor
 *    signs in from the glass /signin; the two-step page (/signin/mfa) is in
 *    glass from its first frame, the code (RFC 6238 from the lab seed in
 *    STAGE5_MFA_TOTP_SECRET, stage5a-totp.ts) is accepted, and Overview opens
 *    in glass, with no classic frame on either page. The user's account is
 *    set to Night glass first, in a separate browser, so the row read at
 *    sign-in agrees.
 *  - NOTIFICATION NAVIGATION: the bell link opens Notifications and its
 *    first notification link opens the record, in glass, with the same look
 *    on every page, and with exactly the data requests the same two clicks
 *    make in Classic (stage5a-network.ts: method, path, body shape; scene
 *    photos and the appearance save left out).
 *
 * Lab command (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     STAGE5_MFA_EMAIL=... STAGE5_MFA_PASSWORD=... STAGE5_MFA_TOTP_SECRET=... \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/mfa-and-bell.spec.ts
 * The MFA case runs once per build (admin run); the bell case runs in every
 * signed-in role's run, signed in as that role, and skips with its reason
 * where the role has no notification to open.
 */

const NIGHT: Look = { design: 'liquid-glass', theme: 'dark' };
const CLASSIC_DARK: Look = { design: 'classic', theme: 'dark' };

test('Sign-in with MFA in glass: /signin, the two-step page and Overview, with no classic frame', async ({
  browser,
  baseURL,
  request,
}) => {
  onlyOnceAcrossRoles();
  const rollout = await buildRollout(request);
  test.skip(rollout === 'off', 'off: Liquid Glass is not offered.');
  const user = labUser('MFA');

  // The account holds Night glass.
  const setup = await signedOutContext(browser, baseURL!);
  const setupPage = await setup.newPage();
  await signIn(setupPage, user);
  await settleIntroNotice(setupPage);
  await chooseLook(setupPage, CLASSIC_DARK);
  await chooseLook(setupPage, NIGHT);
  await settle(setupPage);
  await setup.close();

  const context = await signedOutContext(browser, baseURL!);
  await recordAttributeHistory(context);
  await arriveWith(context, baseURL!, cookieFor(rollout, 'liquid-glass'));
  await context.addInitScript(() => {
    try {
      localStorage.setItem('theme', 'dark');
    } catch {
      /* storage blocked */
    }
  });
  const page = await context.newPage();
  await page.goto('/signin');
  await waitForLook(page, NIGHT);

  await page.getByLabel(/email/iu).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: /sign in/iu }).click();
  await page.waitForURL(/\/signin\/mfa/u, { timeout: 20_000 });
  await expect(page.locator('#mfa-code')).toBeVisible();
  await waitForLook(page, NIGHT);
  const mfaHistory = await attributeHistory(page);
  expect(neverClassicAfterGlass(mfaHistory), `/signin/mfa: ${mfaHistory.join(' > ')}`).toBe(true);

  // The two-step page answered by the shared helper (it types a fresh code).
  await submitTwoStep(page, user.totpSecret!);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await waitForLook(page, NIGHT);
  await settle(page);
  const history = await attributeHistory(page);
  expect(neverClassicAfterGlass(history), `Overview: ${history.join(' > ')}`).toBe(true);
  await context.close();
});

/** Types a fresh code into the two-step page already on screen. */
async function submitTwoStep(page: Page, secret: string): Promise<void> {
  await page.locator('#mfa-code').fill(await freshTotp(page, secret));
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL(/\/dashboard/u, { timeout: 20_000 });
}

/** The bell, then the first notification that opens a record; the record's path, or null. */
async function bellToRecord(page: Page): Promise<string | null> {
  await page.locator('header a[href="/dashboard/notifications"]').first().click();
  await page.waitForURL('**/dashboard/notifications');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
  const link = page
    .locator('main a[href^="/dashboard/"]:not([href^="/dashboard/notifications"])')
    .first();
  if (!(await link.isVisible().catch(() => false))) return null;
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForURL((url) => url.pathname === new URL(href!, url).pathname, {
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
  return new URL(page.url()).pathname;
}

test('The bell: Notifications and the record it opens are in glass, with the data requests Classic makes', async ({
  page,
}) => {
  test.skip(stage5Role() === null, 'Signed in only.');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  if ((await bellCount(page)) === null) test.skip(true, 'No bell for this user.');
  const origin = new URL(page.url()).origin;

  await chooseLook(page, CLASSIC_DARK);
  await settle(page);
  const classicRequests = recordRequests(page);
  const classicPath = await bellToRecord(page);
  if (classicPath === null) test.skip(true, 'No notification that opens a record for this user.');
  const classicLinks = await linkPaths(page);
  const classicList = classicRequests.list();

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await chooseLook(page, NIGHT);
  await settle(page);
  const glassRequests = recordRequests(page);
  const glassPath = await bellToRecord(page);
  expect(glassPath, 'the same record').toBe(classicPath);
  await waitForLook(page, NIGHT);
  const parity = compareLoads(classicList, glassRequests.list(), origin, classicLinks);
  expect(parity, 'the same data requests in glass as in Classic').toEqual({
    onlyClassic: [],
    onlyGlass: [],
    strayPrefetches: [],
  });
  await chooseLook(page, CLASSIC_DARK);
});
