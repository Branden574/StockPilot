import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  SEQUENCE,
  settleIntroNotice,
  START,
  waitForLook,
  watchRealtimeJoins,
} from './look';

/**
 * IDENTITY ACROSS A LOOK SWITCH (plan 4.6 and 8.2 case 9) on the insights
 * lane's routes: the Reports hub, Book Order Totals, a report with a filter
 * (Inventory valuation), Team and Notifications. A switch between Classic
 * and Liquid Glass, and between Light and Dark in each, is CSS on the same
 * tree: no node is replaced and no mount-only effect runs again.
 *
 *  - Expando probe: before the first switch, a property is set on the page
 *    root (data-glass-page="insights"), the scrolling pane, the sidebar's
 *    nav, the top bar, the h1 and the page's own parts (the hub's grouped
 *    glass block and Classic's list, Book Order Totals' filter card and
 *    books table, Team's first row, the live alerts); after every switch
 *    each node is still in the document and still carries it. A remount
 *    would give a fresh node without it.
 *  - Realtime: Notifications joins its channel once; no switch joins again.
 *  - The URL stays the same.
 *
 * Needs a running server and a signed-in lab manager (storageState from
 * auth.setup.ts) in an organisation with Books, reports and members: the
 * integrator's lab run. In a build without Liquid Glass (`off`) there is
 * nothing to switch, and each test skips; a route with no record to show
 * skips with the reason.
 */

const PROBE = '__lgIdentityProbe';

/** The shell nodes the probe tags on every route. */
const SHELL_NODES = ['main#main-content', 'nav[data-glass="sidebar-nav"]', 'header', 'h1'];

async function tag(page: Page, selectors: readonly string[]): Promise<void> {
  const missing = await page.evaluate(
    ({ selectors, probe }) =>
      selectors.filter((selector) => {
        const node = document.querySelector(selector);
        if (!node) return true;
        (node as unknown as Record<string, unknown>)[probe] = selector;
        return false;
      }),
    { selectors, probe: PROBE },
  );
  expect(missing, 'every probed node exists before the first switch').toEqual([]);
}

/** The probed nodes no longer in the document, or replaced by a fresh node. */
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

async function walk(
  page: Page,
  nodes: readonly string[],
  joins?: { count(): number },
): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
  await waitForLook(page, START);
  const url = page.url();
  await tag(page, nodes);
  const joined = joins?.count() ?? 0;
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    const where = `after ${look.design} ${look.theme}`;
    expect(await lostNodes(page, nodes), where).toEqual([]);
    if (joins) expect(joins.count(), `realtime joins ${where}`).toBe(joined);
    expect(page.url()).toBe(url);
  }
}

/** The selectors of `candidates` that are on the page now. */
async function present(page: Page, candidates: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const selector of candidates) {
    if ((await page.locator(selector).count()) > 0) out.push(selector);
  }
  return out;
}

test('Reports hub: the same nodes, the grouped glass block and Classic list included', async ({
  page,
}) => {
  await page.goto('/dashboard/reports');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const root = '[data-glass-page="insights"][data-glass-view="reports-hub"]';
  await expect(page.locator(root)).toHaveCount(1);
  // The glass-only block renders in every look of a glass build (CSS hides
  // it in Classic), so it is the same node across a switch too.
  const parts = await present(page, [
    '[data-glass="reports-hub"]',
    '[data-glass-role="reports-classic-list"]',
  ]);
  await walk(page, [root, ...SHELL_NODES, ...parts]);
});

test('Book Order Totals: the same nodes, the filter card and the books table included', async ({
  page,
}) => {
  await page.goto('/dashboard/reports/book-order-totals');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const root = '[data-glass-page="insights"][data-glass-view="book-order-totals"]';
  if ((await page.locator(root).count()) === 0)
    test.skip(true, 'Book Order Totals is not offered to this user (Books off, or no access).');
  await expect(page.locator('[data-glass-role="bot-filters"]')).toBeVisible();
  const parts = await present(page, [
    '[data-glass-role="bot-filters"]',
    '[data-glass-role="bot-kpis"]',
    '[data-glass-role="bot-table"]',
    '[data-by-charter]',
  ]);
  await walk(page, [root, ...SHELL_NODES, ...parts]);
});

test('Inventory valuation: the same nodes, the charter selector included', async ({ page }) => {
  await page.goto('/dashboard/reports/inventory-valuation');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const root = '[data-glass-page="insights"]';
  if ((await page.locator(root).count()) === 0)
    test.skip(true, 'Inventory valuation is not offered to this user.');
  const parts = await present(page, [
    '[data-glass-role="report-charter-select"]',
    '[data-glass="table"] tbody tr:first-child',
  ]);
  await walk(page, [root, ...SHELL_NODES, ...parts]);
});

test('Team: the same nodes, the first member row included', async ({ page }) => {
  await page.goto('/dashboard/team');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const root = '[data-glass-page="insights"][data-glass-view="team"]';
  if ((await page.locator(root).count()) === 0)
    test.skip(true, 'Team is not offered to this user.');
  const parts = await present(page, ['table tbody tr:first-child']);
  await walk(page, [root, ...SHELL_NODES, ...parts]);
});

test('Notifications: the same nodes and no second realtime join', async ({ page }) => {
  const joins = watchRealtimeJoins(page);
  await page.goto('/dashboard/notifications');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const root = '[data-glass-page="insights"][data-glass-view="notifications"]';
  await expect(page.locator(root)).toHaveCount(1);
  const parts = await present(page, ['[data-glass-role="live-alerts"]']);
  await walk(page, [root, ...SHELL_NODES, ...parts], joins);
});
