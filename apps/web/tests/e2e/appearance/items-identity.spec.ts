import { expect, test, type Page } from '@playwright/test';

import { chooseLook, glassBuild, SEQUENCE, settleIntroNotice, START, waitForLook } from './look';

/**
 * IDENTITY ACROSS A LOOK SWITCH (plan 4.6 and 8.2 case 9) on the items lane's
 * routes: Items, Books, an item's page and a book's page. A switch between
 * Classic and Liquid Glass, and between Light and Dark in each, is CSS on
 * the same tree: no node is replaced and no mount-only effect runs again.
 *
 *  - Expando probe: before the first switch, a property is set on the page
 *    root, the scrolling pane, the sidebar's nav, the top bar, the h1 and
 *    (on a list) the first row; after every switch each node is still in the
 *    document and still carries it. A remount would give a fresh node
 *    without the property.
 *  - Mount-only effects: every page here mounts PerfUseful, whose mount
 *    stamps one `stockpilot:navigation-useful` mark (lib/perf/marks.ts); the
 *    number of those marks never grows across the switches.
 *  - The URL stays the same.
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts) in an organisation with items and books: the integrator's
 * lab run. In a build without Liquid Glass (`off`) there is nothing to
 * switch, and each test skips.
 */

const PROBE = '__lgIdentityProbe';
const USEFUL_MARK = 'stockpilot:navigation-useful';

/** Selectors of the nodes the probe tags; each must exist on the route. */
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

async function walk(page: Page, url: string, nodes: readonly string[]): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
  await waitForLook(page, START);
  await tag(page, nodes);
  const marks = await usefulMarks(page);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    expect(await lostNodes(page, nodes), `after ${look.design} ${look.theme}`).toEqual([]);
    expect(await usefulMarks(page), `mount-only effects after ${look.design} ${look.theme}`).toBe(
      marks,
    );
    expect(page.url()).toBe(url);
  }
}

test('Items: the same nodes through Dark, Liquid Glass Night and Day, Light and Dark', async ({
  page,
}) => {
  await page.goto('/dashboard/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const firstRow = page.getByRole('table').locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false)))
    test.skip(true, 'No items in this organisation.');
  await walk(page, page.url(), [
    '[data-glass-page="items"]',
    ...SHELL_NODES,
    'table tbody tr:first-child',
  ]);
});

test('Books: the same nodes through every switch', async ({ page }) => {
  await page.goto('/dashboard/books');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const firstRow = page.getByRole('table').locator('tbody tr').first();
  if (!(await firstRow.isVisible().catch(() => false)))
    test.skip(true, 'No books in this organisation.');
  await walk(page, page.url(), [
    '[data-glass-page="books"]',
    ...SHELL_NODES,
    'table tbody tr:first-child',
  ]);
});

/** Opens the first record of a list, by its name link. */
async function openFirstRecord(page: Page, list: string): Promise<boolean> {
  await page.goto(list);
  const link = page.getByRole('table').locator('tbody tr a[href^="/dashboard/"]').first();
  if (!(await link.isVisible().catch(() => false))) return false;
  await link.click();
  await expect(page.locator('[data-glass-page="item-detail"]')).toBeVisible();
  return true;
}

test('An item page: the same nodes, the sticky header and the tab strip included', async ({
  page,
}) => {
  if (!(await openFirstRecord(page, '/dashboard/inventory'))) test.skip(true, 'No items.');
  await walk(page, page.url(), [
    '[data-glass-page="item-detail"]',
    '[data-item-detail-header]',
    '[role="tablist"]',
    ...SHELL_NODES,
  ]);
});

test('A book page: the same nodes through every switch', async ({ page }) => {
  if (!(await openFirstRecord(page, '/dashboard/books'))) test.skip(true, 'No books.');
  await walk(page, page.url(), [
    '[data-glass-page="item-detail"]',
    '[data-item-detail-header]',
    '[role="tablist"]',
    ...SHELL_NODES,
  ]);
});
