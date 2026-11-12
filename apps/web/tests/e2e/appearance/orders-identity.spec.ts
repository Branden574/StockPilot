import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  openFirstOrder,
  SEQUENCE,
  settleIntroNotice,
  START,
  waitForLook,
  watchRealtimeJoins,
} from './orders-look';

/**
 * IDENTITY ACROSS A LOOK SWITCH (plan 4.6 and 8.2 case 9) on the orders
 * lane's routes: the Orders list, Place an order, an order's page, its
 * digital pick and Manage order items. A switch between Classic and Liquid
 * Glass, and between Light and Dark in each, is CSS on the same tree: no
 * node is replaced and no mount-only effect runs again.
 *
 *  - Expando probe: before the first switch, a property is set on the page
 *    root, the scrolling pane, the sidebar's nav, the top bar, the h1 and the
 *    page's own parts (the first row, the lines card, the side column, the
 *    pick card); after every switch each node is still in the document and
 *    still carries it. A remount would give a fresh node without it.
 *  - Mount-only effects: the Orders list and Place an order mount
 *    PerfUseful, whose mount stamps one `stockpilot:navigation-useful` mark
 *    (lib/perf/marks.ts); the number of those marks never grows. The order
 *    page joins its realtime channel once (OrderRealtimeRefresh); no switch
 *    joins it again.
 *  - The URL stays the same.
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts) who can approve orders, in an organisation with orders:
 * the integrator's lab run. In a build without Liquid Glass (`off`) there
 * is nothing to switch, and each test skips; a route with no record to show
 * skips with the reason.
 */

const PROBE = '__lgIdentityProbe';
const USEFUL_MARK = 'stockpilot:navigation-useful';

/** Selectors of the shell nodes the probe tags on every route. */
const SHELL_NODES = [
  'main#main-content',
  'nav[data-glass="sidebar-nav"]',
  'nav[aria-label="Breadcrumb"]',
  'header',
  'h1',
];

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

async function usefulMarks(page: Page): Promise<number> {
  return page.evaluate((name) => performance.getEntriesByName(name).length, USEFUL_MARK);
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
  const marks = await usefulMarks(page);
  const joined = joins?.count() ?? 0;
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    const where = `after ${look.design} ${look.theme}`;
    expect(await lostNodes(page, nodes), where).toEqual([]);
    expect(await usefulMarks(page), `mount-only effects ${where}`).toBe(marks);
    if (joins) expect(joins.count(), `realtime joins ${where}`).toBe(joined);
    expect(page.url()).toBe(url);
  }
}

test('Orders list: the same nodes through Dark, Liquid Glass Night and Day, Light and Dark', async ({
  page,
}) => {
  await page.goto('/dashboard/orders?status=all_active');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const firstRow = page.getByRole('table').locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false)))
    test.skip(true, 'No open orders in this organisation.');
  const nodes = ['[data-glass-page="orders"]', ...SHELL_NODES, 'table tbody tr:first-child'];
  // The phone cards are rendered in every look of a glass build (CSS shows
  // them only in glass at 760 px and under), so they are the same nodes too.
  if ((await page.locator('[data-glass="orders-phone-cards"]').count()) > 0)
    nodes.push('[data-glass="orders-phone-cards"]');
  await walk(page, nodes);
});

test('Place an order: the same nodes, the storefront and the cart included', async ({ page }) => {
  await page.goto('/dashboard/orders/new');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (
    !(await page
      .locator('.sp-storefront')
      .isVisible()
      .catch(() => false))
  )
    test.skip(true, 'No warehouse to order from in this organisation.');
  await walk(page, ['.sp-storefront[data-glass-page="order-new"]', ...SHELL_NODES]);
});

test('An order page: the same nodes and no second realtime join', async ({ page }) => {
  const joins = watchRealtimeJoins(page);
  if (!(await openFirstOrder(page, 'all_active'))) test.skip(true, 'No open orders.');
  await walk(
    page,
    [
      '[data-glass-page="order-detail"]',
      '[data-glass-role="order-lines"]',
      '[data-glass="order-detail-aside"]',
      ...SHELL_NODES,
    ],
    joins,
  );
});

test('The digital pick: the same nodes, the pick card included', async ({ page }) => {
  if (!(await openFirstOrder(page, 'picking'))) test.skip(true, 'No order in picking.');
  const open = page.getByRole('link', { name: 'Open digital pick' });
  if (!(await open.isVisible().catch(() => false)))
    test.skip(true, 'This user is not offered the digital pick on that order.');
  await open.click();
  await expect(page.locator('[data-glass-page="order-pick"]')).toBeVisible();
  const nodes = ['[data-glass-page="order-pick"]', ...SHELL_NODES];
  if ((await page.locator('[data-testid="digital-pick"]').count()) > 0)
    nodes.push('[data-testid="digital-pick"]');
  await walk(page, nodes);
});

test('Manage order items: the same nodes through every switch', async ({ page }) => {
  await page.goto('/dashboard/orders/manage-items');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const firstRow = page.getByRole('table').locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false)))
    test.skip(true, 'This user cannot manage order items, or there are no items.');
  await walk(page, [
    '[data-glass-page="manage-items"]',
    '[data-glass="filter-bar"]',
    ...SHELL_NODES,
    'table tbody tr:first-child',
  ]);
});
