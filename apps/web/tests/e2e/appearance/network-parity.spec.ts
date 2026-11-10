import { expect, test, type Browser, type Page } from '@playwright/test';

import { chooseLook, settle, settleIntroNotice, type Look } from './look';
import {
  buildRollout,
  cookieFor,
  MARKETING_PATHS,
  skipLandingIntro,
  type Rollout,
} from './site-look';
import { contextWithLook, linkPaths, recordRequests, stage5Role } from './stage5a-lib';
import { compareLoads, holdsDocument } from './stage5a-network';

/**
 * PROVES plan 8.5 "network parity": per route, the set of data requests a
 * page load makes (method, path, body shape: stage5a-network.ts, unit test
 * src/test/stage5a-network.test.ts) is the same in Classic and in Liquid
 * Glass, apart from the scene photos and the appearance save and Design
 * cookie route; and glass prefetches no page Classic's page does not link
 * to. Each load is a fresh browser context (no cache, no router state) whose
 * appearance records and account both say the look measured (the account is
 * set first through the header menu, so the account read adopts nothing).
 *
 * Each load must hold its own document request (GET <path>), so a recorder
 * that saw nothing cannot compare as equal.
 *
 * Routes: the items, orders and insights lanes, Overview and AI (as
 * action-inventory.spec.ts's DASHBOARD_ROUTES), the first item, book and order, signed in per
 * role; the 7 marketing pages and the auth pages in the signed-out run.
 *
 * Lab command, per role and the signed-out run (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=<role> \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/network-parity.spec.ts
 */

const CLASSIC: Look = { design: 'classic', theme: 'dark' };
const GLASS: Look = { design: 'liquid-glass', theme: 'dark' };
const ID = '[0-9a-f-]{36}';

const SIGNED_IN = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/orders/manage-items',
  '/dashboard/reports',
  '/dashboard/reports/book-order-totals',
  '/dashboard/reports/inventory-valuation',
  '/dashboard/team',
  '/dashboard/notifications',
  '/dashboard/help',
  '/dashboard/ai',
];
const RECORDS = [
  { list: '/dashboard/inventory', record: new RegExp(`^/dashboard/inventory/${ID}$`, 'u') },
  { list: '/dashboard/books', record: new RegExp(`^/dashboard/books/${ID}$`, 'u') },
  {
    list: '/dashboard/orders?status=all_active',
    record: new RegExp(`^/dashboard/orders/${ID}$`, 'u'),
  },
];
const SIGNED_OUT = [...MARKETING_PATHS, '/signin', '/signup', '/reset'];

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});
test.beforeEach(() => {
  test.skip(rollout === 'off', 'off: Liquid Glass is not offered.');
});

interface Load {
  requests: ReturnType<ReturnType<typeof recordRequests>['list']>;
  links: string[];
  ok: boolean;
}

/** One load of `path` in a fresh context showing `look`. */
async function load(browser: Browser, baseURL: string, path: string, look: Look): Promise<Load> {
  const context = await contextWithLook(browser, baseURL, look, cookieFor(rollout, look.design));
  const page = await context.newPage();
  await skipLandingIntro(page);
  const requests = recordRequests(page);
  const response = await page.goto(path);
  await settle(page);
  const ok = Boolean(response && response.status() < 400 && new URL(page.url()).pathname === path);
  const glass = await page.evaluate(
    () => document.documentElement.getAttribute('data-appearance') === 'liquid-glass',
  );
  expect(glass, `${path} loaded in ${look.design}`).toBe(look.design === 'liquid-glass');
  const out = { requests: requests.list(), links: await linkPaths(page), ok };
  await context.close();
  return out;
}

/** Makes the signed-in account hold `look` (through the header menu). */
async function accountHolds(page: Page, look: Look): Promise<void> {
  await page.goto('/dashboard/whats-new');
  await settleIntroNotice(page);
  await chooseLook(page, look);
  await settle(page);
}

async function compareRoute(
  browser: Browser,
  baseURL: string,
  path: string,
  page: Page | null,
): Promise<void> {
  if (page) await accountHolds(page, CLASSIC);
  const classic = await load(browser, baseURL, path, CLASSIC);
  if (!classic.ok) test.skip(true, `${path} is not open to this run.`);
  if (page) await accountHolds(page, GLASS);
  const glass = await load(browser, baseURL, path, GLASS);
  if (page) await accountHolds(page, CLASSIC);
  const origin = new URL(baseURL).origin;
  expect(
    holdsDocument(classic.requests, origin, path),
    `${path}: Classic's load holds GET ${path}`,
  ).toBe(true);
  expect(glass.ok, `${path}: the glass load reached the page`).toBe(true);
  expect(
    holdsDocument(glass.requests, origin, path),
    `${path}: the glass load holds GET ${path}`,
  ).toBe(true);
  expect(
    compareLoads(classic.requests, glass.requests, new URL(baseURL).origin, classic.links),
    `${path} (${process.env.STAGE5_ROLE ?? 'signed out'}): the same data requests`,
  ).toEqual({ onlyClassic: [], onlyGlass: [], strayPrefetches: [] });
}

test.describe('signed in', () => {
  test.beforeEach(() => {
    const role = stage5Role();
    test.skip(role === null || role === 'portal', 'Needs an organisation member’s run.');
  });

  for (const path of SIGNED_IN) {
    test(`${path}: the same data requests in Classic and in Liquid Glass`, async ({
      browser,
      baseURL,
      page,
    }) => {
      await compareRoute(browser, baseURL!, path, page);
    });
  }

  for (const { list, record } of RECORDS) {
    test(`The first record ${list} links to: the same data requests`, async ({
      browser,
      baseURL,
      page,
    }) => {
      await page.goto(list);
      const hrefs = await page
        .locator('main a[href]')
        .evaluateAll((links) => links.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
      const path = hrefs.find((p) => record.test(p));
      if (!path) test.skip(true, `No record to open from ${list} for this role.`);
      await compareRoute(browser, baseURL!, path!, page);
    });
  }
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    test.skip(stage5Role() !== null, 'Runs in the signed-out run.');
  });

  for (const path of SIGNED_OUT) {
    test(`${path}: the same data requests in Classic and in Liquid Glass`, async ({
      browser,
      baseURL,
    }) => {
      await compareRoute(browser, baseURL!, path, null);
    });
  }
});
