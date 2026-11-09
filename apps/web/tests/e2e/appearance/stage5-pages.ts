import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { chooseLook, glassBuild, settle, settleIntroNotice, waitForLook, type Look } from './look';
import { MARKETING_PATHS, skipLandingIntro } from './site-look';

/**
 * The routes and looks the stage 5 accessibility specs walk (plan 8.3:
 * "every route in Dark, Light, Day glass and Night glass"), and how a look is
 * put on screen:
 *  - signed in: through the header appearance menu (look.ts chooseLook), the
 *    real control, once; the choice then holds on every page (cookie, device
 *    record and the account row agree);
 *  - signed out: the Design cookie and next-themes' stored theme are set
 *    before the first load (there is no account row to reconcile with).
 */

export interface NamedLook extends Look {
  label: 'Dark' | 'Light' | 'Day glass' | 'Night glass';
}
export const FOUR_LOOKS: readonly NamedLook[] = [
  { label: 'Dark', design: 'classic', theme: 'dark' },
  { label: 'Light', design: 'classic', theme: 'light' },
  { label: 'Day glass', design: 'liquid-glass', theme: 'light' },
  { label: 'Night glass', design: 'liquid-glass', theme: 'dark' },
];
export const GLASS_LOOKS = FOUR_LOOKS.filter((l) => l.design === 'liquid-glass');

/** Signed-in routes with no record in the path (each drawn by a lane of stages 3 and 4). */
export const SIGNED_IN_ROUTES = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/orders/manage-items',
  '/dashboard/purchase-orders',
  '/dashboard/purchase-orders/new',
  '/dashboard/cycle-counts',
  '/dashboard/returns',
  '/dashboard/movements',
  '/dashboard/exceptions',
  '/dashboard/reports',
  '/dashboard/reports/book-order-totals',
  '/dashboard/reports/inventory-valuation',
  '/dashboard/team',
  '/dashboard/notifications',
  '/dashboard/help',
  '/dashboard/whats-new',
  '/dashboard/settings',
  '/dashboard/warehouses',
  '/dashboard/locations',
  '/dashboard/suppliers',
] as const;

/** Detail routes: the first record linked from a list. */
export const DETAIL_ROUTES = [
  {
    what: 'item page',
    list: '/dashboard/inventory',
    link: 'tbody a[href^="/dashboard/inventory/"]',
  },
  { what: 'book page', list: '/dashboard/books', link: 'tbody a[href^="/dashboard/"]' },
  {
    what: 'order page',
    list: '/dashboard/orders',
    link: 'main a[href^="/dashboard/orders/"]:not([href$="/new"]):not([href*="manage-items"])',
  },
  {
    what: 'purchase order page',
    list: '/dashboard/purchase-orders',
    link: 'main a[href^="/dashboard/purchase-orders/"]:not([href$="/new"])',
  },
  {
    what: 'cycle count page',
    list: '/dashboard/cycle-counts',
    link: 'main a[href^="/dashboard/cycle-counts/"]:not([href$="/new"])',
  },
  {
    what: 'return page',
    list: '/dashboard/returns',
    link: 'main a[href^="/dashboard/returns/"]:not([href$="/new"])',
  },
] as const;

/** Signed-out routes: the 7 marketing pages and the auth pages. */
export const SIGNED_OUT_ROUTES = [...MARKETING_PATHS, '/signin', '/signup', '/reset'] as const;

/** The platform console (platform admin at aal2 only); an organisation page is reached from it. */
export const PLATFORM_ROUTES = ['/platform'] as const;

/** The R11 set (contrast in Chromium and WebKit): marketing, auth, Overview, Items, Place an Order. */
export const R11_ROUTES = [
  ...MARKETING_PATHS,
  '/signin',
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/orders/new',
] as const;

export const isSignedOutRoute = (path: string) =>
  (SIGNED_OUT_ROUTES as readonly string[]).includes(path);

/** Skips the test unless this build offers Liquid Glass (look.ts glassBuild). */
export async function requireGlass(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
}

/** Signed out: the Design cookie and stored theme a visitor arrives with. */
export async function arriveSignedOut(
  context: BrowserContext,
  baseURL: string,
  look: Look,
): Promise<void> {
  await context.clearCookies({ name: 'sp_style' });
  await context.addCookies([{ name: 'sp_style', value: look.design, url: baseURL }]);
  await context.addInitScript((theme) => {
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* storage blocked: the theme then follows the system, which the context also emulates */
    }
  }, look.theme);
}

/** Signed in: picks the look once through the header menu (on a light page). */
export async function chooseSignedIn(page: Page, look: Look): Promise<void> {
  await page.goto('/dashboard/whats-new');
  await expect(page.locator('#theme-toggle-trigger')).toBeVisible();
  if (look.design === 'liquid-glass') await requireGlass(page);
  await settleIntroNotice(page);
  await chooseLook(page, look);
  await settle(page);
}

/** Opens `path` and waits until it has drawn (a level-one heading or the main landmark). */
export async function visit(page: Page, path: string, look: Look | null): Promise<boolean> {
  if (isSignedOutRoute(path)) await skipLandingIntro(page);
  const response = await page.goto(path);
  if (!response || response.status() >= 400) return false;
  await page
    .locator('h1, main')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
  await settleIntroNotice(page);
  if (look) await waitForLook(page, look);
  await settle(page);
  return true;
}

/** Resolves a detail route to the path of its first record (null: the list has none). */
export async function firstRecordPath(
  page: Page,
  route: { what: string; list: string; link: string },
): Promise<string | null> {
  await page.goto(route.list);
  await page
    .locator('h1')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
  const href = await page
    .locator(route.link)
    .first()
    .getAttribute('href', { timeout: 5_000 })
    .catch(() => null);
  return href ? new URL(href, page.url()).pathname : null;
}
