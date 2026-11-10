import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  chooseLookElsewhere,
  glassBuild,
  openRemote,
  SEQUENCE,
  settle,
  settleIntroNotice,
  START,
  waitForLook,
  watchDataRequests,
  watchRealtimeJoins,
} from './look';

/**
 * PROVES plan 8.2 case 9 (identity, plan 4.6) on the M2 pages no earlier
 * identity spec walked: Overview (/dashboard), the platform console's
 * directory (/platform) and an organisation's page (/platform/orgs/[id]),
 * a return, a cycle count and a purchase order (ops-transitions.spec.ts
 * checked their state, not their nodes). Through Dark, Liquid Glass Night
 * and Day, Light and Dark:
 *  - EXPANDO PROBE: a property set before the first switch on the page
 *    root, the scrolling pane, the sidebar's nav, the breadcrumb, the top
 *    bar, the h1 and the page's first card or row is still on the same node
 *    after every switch (a remount would give a fresh node without it);
 *  - EVERY ROW AND CARD (and list item) under the page root, up to 60 of
 *    each, is tagged too and must still be the same node;
 *  - MOUNT-ONLY EFFECTS RUN ONCE: no performance mark is added (Overview
 *    mounts PerfUseful, whose mount stamps stockpilot:navigation-useful, and
 *    the walk first requires that mark there; the other five routes mount no
 *    PerfUseful, so for them the mark count is a side check and the rows,
 *    cards and churn are the proof), no realtime channel is joined again
 *    (phx_join frames) and no data request is made (switch-requests.ts), so
 *    no effect that loads on mount ran again;
 *  - NO ELEMENT IS REMOVED under the page root by a switch (one slot-frame
 *    tree per page, CSS-only composition: plan 4.6, R1); the elements added
 *    are recorded as an annotation;
 *  - the URL stays.
 *
 * Lab command (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=<role> \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/identity-more.spec.ts
 * The dashboard pages run in the admin and manager runs (any role that can
 * open them); the console pages need STAGE5_ROLE=platform (a platform admin
 * at the two-step level) and skip where /platform answers 404.
 */

const PROBE = '__lgIdentityMore';

/** Candidate nodes; each one present on the route is probed (at least the pane and the h1). */
const DASHBOARD_NODES = [
  'main#main-content',
  'nav[data-glass="sidebar-nav"]',
  'nav[aria-label="Breadcrumb"]',
  'header',
  'h1',
  '[data-glass-page]',
  'main#main-content table tbody tr:first-child',
  'main#main-content [data-slot="card"]',
];
const CONSOLE_NODES = [
  '[data-glass-page="platform"]',
  'main',
  'h1',
  '[data-glass-page="platform"] nav',
  '[data-glass-page="platform"] table tbody tr:first-child',
];

async function tagPresent(page: Page, candidates: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ({ candidates, probe }) =>
      candidates.filter((selector) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        (node as unknown as Record<string, unknown>)[probe] = selector;
        return true;
      }),
    { candidates, probe: PROBE },
  );
}

async function lostNodes(page: Page, selectors: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ({ selectors, probe }) =>
      selectors.filter((selector) => {
        const node = document.querySelector(selector);
        return !node || (node as unknown as Record<string, unknown>)[probe] !== selector;
      }),
    { selectors, probe: PROBE },
  );
}

async function markCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType('mark').length);
}

/** Counts elements added and removed under the page root from now on. */
async function watchChurn(page: Page): Promise<() => Promise<{ added: number; removed: number }>> {
  const rooted = await page.evaluate(() => {
    const w = window as unknown as { __lgChurn?: { added: number; removed: number } };
    w.__lgChurn = { added: 0, removed: 0 };
    const root = document.querySelector('main#main-content') ?? document.querySelector('main');
    if (!root) return false;
    new MutationObserver((records) => {
      for (const r of records) {
        w.__lgChurn!.added += [...r.addedNodes].filter((n) => n.nodeType === 1).length;
        w.__lgChurn!.removed += [...r.removedNodes].filter((n) => n.nodeType === 1).length;
      }
    }).observe(root, { childList: true, subtree: true });
    return true;
  });
  expect(rooted, 'a page root (main) to watch for element churn').toBe(true);
  return async () =>
    page.evaluate(() => {
      const c = (window as unknown as { __lgChurn?: { added: number; removed: number } }).__lgChurn;
      return { added: c?.added ?? 0, removed: c?.removed ?? 0 };
    });
}

/**
 * Every row and card under the page root (at most `limit` of each), tagged
 * with its own token and kept in a list, so a remount of any one of them is
 * seen, not only of the first. Returns how many were tagged.
 */
const EVERY_NODE = ['tbody tr', '[data-slot="card"]', 'li'];
async function tagEvery(page: Page, limit = 60): Promise<number> {
  return page.evaluate(
    ({ selectors, probe, limit }) => {
      const root = document.querySelector('main#main-content') ?? document.querySelector('main');
      const w = window as unknown as { __lgEvery?: Array<{ node: Element; token: string }> };
      w.__lgEvery = [];
      if (!root) return 0;
      for (const selector of selectors) {
        [...root.querySelectorAll(selector)].slice(0, limit).forEach((node, i) => {
          const token = `${selector}#${i}`;
          (node as unknown as Record<string, unknown>)[`${probe}Every`] = token;
          w.__lgEvery!.push({ node, token });
        });
      }
      return w.__lgEvery.length;
    },
    { selectors: EVERY_NODE, probe: PROBE, limit },
  );
}

async function lostEvery(page: Page): Promise<string[]> {
  return page.evaluate((probe) => {
    const w = window as unknown as { __lgEvery?: Array<{ node: Element; token: string }> };
    return (w.__lgEvery ?? [])
      .filter(
        ({ node, token }) =>
          !node.isConnected ||
          (node as unknown as Record<string, unknown>)[`${probe}Every`] !== token,
      )
      .map(({ token }) => token);
  }, PROBE);
}

/**
 * Walks the sequence on `page`; `switchTo` makes each switch (the header menu,
 * or a second tab on the console, which has no menu). `mountsPerfUseful`: the
 * route mounts PerfUseful (only Overview among these), so its mount mark must
 * be there before the walk, or the mark count could not move by construction.
 * On every route a switch removes no element under the page root (one
 * slot-frame tree per page, CSS-only composition, plan 4.6 and R1), and every
 * row and card is still the same node: on the routes without PerfUseful those
 * are what proves no subtree remounted.
 */
async function walk(
  page: Page,
  candidates: readonly string[],
  joins: { count(): number },
  switchTo: (look: (typeof SEQUENCE)[number]) => Promise<void>,
  mountsPerfUseful = false,
): Promise<void> {
  await settle(page);
  const url = page.url();
  const probed = await tagPresent(page, candidates);
  expect(probed, 'the pane (or the console root) and the h1 are probed').toEqual(
    expect.arrayContaining([candidates[0]!, 'h1']),
  );
  const every = await tagEvery(page);
  const marks = await markCount(page);
  if (mountsPerfUseful)
    expect(marks, 'the page’s PerfUseful mount mark is there before the walk').toBeGreaterThan(0);
  const joined = joins.count();
  const requests = await watchDataRequests(page);
  const churn = await watchChurn(page);
  for (const look of SEQUENCE) {
    await switchTo(look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(await lostNodes(page, probed), `nodes ${where}`).toEqual([]);
    expect(await lostEvery(page), `rows and cards (${every} probed) ${where}`).toEqual([]);
    expect(await markCount(page), `performance marks (mount-only effects) ${where}`).toBe(marks);
    expect(joins.count(), `realtime joins ${where}`).toBe(joined);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect((await churn()).removed, `elements removed under the page root ${where}`).toBe(0);
    expect(page.url(), where).toBe(url);
  }
  const { added, removed } = await churn();
  test.info().annotations.push({
    type: 'element churn under the page root',
    description: `added ${added}, removed ${removed}; ${every} rows and cards probed`,
  });
}

async function dashboardWalk(
  page: Page,
  joins: { count(): number },
  mountsPerfUseful = false,
): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
  await waitForLook(page, START);
  await walk(page, DASHBOARD_NODES, joins, (look) => chooseLook(page, look), mountsPerfUseful);
}

/** The first record `list` links to, matching `pattern`, or null. */
async function firstRecord(page: Page, list: string, pattern: RegExp): Promise<string | null> {
  await page.goto(list);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const hrefs = await page
    .locator('main a[href]')
    .evaluateAll((links) => links.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
  return hrefs.find((path) => pattern.test(path)) ?? null;
}

const ID = '[0-9a-f-]{36}';

test.describe('dashboard pages', () => {
  test.beforeEach(() => {
    test.skip(
      ['platform', 'portal', 'anonymous', undefined].includes(process.env.STAGE5_ROLE),
      'Needs an organisation member’s run.',
    );
  });

  test('Overview: the same nodes, mount-only effects once', async ({ page }) => {
    const joins = watchRealtimeJoins(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // Overview mounts PerfUseful (app/(dashboard)/dashboard/page.tsx).
    await dashboardWalk(page, joins, true);
  });

  const RECORDS = [
    {
      name: 'A return',
      list: '/dashboard/returns',
      record: new RegExp(`^/dashboard/returns/${ID}$`, 'u'),
    },
    {
      name: 'A cycle count',
      list: '/dashboard/cycle-counts?status=in_progress',
      record: new RegExp(`^/dashboard/cycle-counts/${ID}$`, 'u'),
    },
    {
      name: 'A completed cycle count',
      list: '/dashboard/cycle-counts?status=completed',
      record: new RegExp(`^/dashboard/cycle-counts/${ID}$`, 'u'),
    },
    {
      name: 'A purchase order',
      list: '/dashboard/purchase-orders',
      record: new RegExp(`^/dashboard/purchase-orders/${ID}$`, 'u'),
    },
  ];
  for (const { name, list, record } of RECORDS) {
    test(`${name}: the same nodes, mount-only effects once`, async ({ page }) => {
      const joins = watchRealtimeJoins(page);
      const path = await firstRecord(page, list, record);
      if (!path) test.skip(true, `${name}: no record to open from ${list} for this user.`);
      await page.goto(path!);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await dashboardWalk(page, joins);
    });
  }
});

test.describe('the platform console', () => {
  test.beforeEach(() => {
    test.skip(process.env.STAGE5_ROLE !== 'platform', 'Needs the platform admin’s run.');
  });

  test('/platform (the directory): the same nodes, mount-only effects once', async ({
    page,
    context,
  }) => {
    const joins = watchRealtimeJoins(page);
    const remote = await openRemote(context);
    const response = await page.goto('/platform');
    if (!response || response.status() === 404)
      test.skip(true, 'This user is not a platform admin at the two-step level.');
    if (!(await glassBuild(remote))) test.skip(true, 'This build does not offer Liquid Glass.');
    await chooseLookElsewhere(remote, page, START);
    await walk(page, CONSOLE_NODES, joins, (look) => chooseLookElsewhere(remote, page, look));
    await remote.close();
  });

  test('/platform/orgs/[id] (an organisation): the same nodes, mount-only effects once', async ({
    page,
    context,
  }) => {
    const joins = watchRealtimeJoins(page);
    const remote = await openRemote(context);
    const response = await page.goto('/platform');
    if (!response || response.status() === 404)
      test.skip(true, 'This user is not a platform admin at the two-step level.');
    if (!(await glassBuild(remote))) test.skip(true, 'This build does not offer Liquid Glass.');
    const org = page
      .getByRole('region', { name: 'Organizations' })
      .locator('tbody a[href^="/platform/orgs/"]')
      .first();
    if (!(await org.isVisible().catch(() => false))) test.skip(true, 'No organisations.');
    const href = await org.getAttribute('href');
    await page.goto(href!.split('?')[0]!);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await chooseLookElsewhere(remote, page, START);
    await walk(page, CONSOLE_NODES, joins, (look) => chooseLookElsewhere(remote, page, look));
    await remote.close();
  });
});
