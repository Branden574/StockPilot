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
  watchDataRequests,
} from './orders-look';

/**
 * TRANSITIONS AND IDENTITY ON THE OPERATIONS LANE (stage 4, lane L1; brief
 * section 13, plan 4.6 and 8.2 cases 1 to 3 and 9). Through Dark, Liquid
 * Glass (Night, then Day), Light and Dark:
 *  - Every operations page this lane composes draws its inert root hook
 *    (data-glass-page="ops"), renders no glass-only part under Classic, and
 *    a switch replaces no node: a property set on the page root, the h1 and
 *    the first card before the first switch is still there after every
 *    switch, and the URL stays.
 *  - Under Liquid Glass the page takes the board's frame (pages/ops.css: the
 *    1480 px page, the 26 px title); under Classic the same page keeps its
 *    own (1320 px or its form's width, the Classic title size).
 *  - The cycle count history: the open status, a typed search and the URL
 *    stay, and no data request is made (switch-requests.ts).
 *  - A cycle count in progress: a typed, unsaved count stays in its field;
 *    with Review & post open, switches made in a second tab keep the dialog
 *    open with focus inside it, and Escape still closes it.
 *  - A purchase order with lines to receive: the Receive dialog, with a
 *    typed quantity, stays open with the quantity and focus inside through
 *    switches made in a second tab.
 *  - A return: the Next step actions and the scroll stay; no data request.
 *
 * Needs a running server and a signed-in lab user who manages inventory
 * (cycle counts, purchase orders, returns), in an organisation with a cycle
 * count in progress, a purchase order with lines to receive and a return:
 * the integrator's lab run. Each test skips, with its reason, where the lab
 * has no such record or the user is not offered the control; every test
 * skips in a build without Liquid Glass.
 */

const PROBE = '__lgOpsIdentityProbe';

/** Every route the lane composes that needs no record, with its title. */
const LIST_ROUTES = [
  '/dashboard/cycle-counts',
  '/dashboard/exceptions',
  '/dashboard/movements',
  '/dashboard/returns',
  '/dashboard/rentals',
  '/dashboard/bundles',
  '/dashboard/schedule',
  '/dashboard/customers',
  '/dashboard/maintenance',
  '/dashboard/procedures',
  '/dashboard/purchase-orders',
  '/dashboard/purchase-orders/imports',
  '/dashboard/purchase-orders/recurring',
  '/dashboard/planning',
  '/dashboard/suppliers',
  '/dashboard/locations',
  '/dashboard/categories',
  '/dashboard/tags',
] as const;

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

/** The lane's page root, or null where the route drew another page (a
 *  module that is off, a refusal). */
async function laneRoot(page: Page) {
  const root = page.locator('[data-glass-page="ops"]').first();
  return (await root.count()) > 0 ? root : null;
}

for (const route of LIST_ROUTES) {
  test(`${route}: the root hook is drawn, Classic renders no glass-only part, and no switch replaces a node`, async ({
    page,
  }) => {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await ready(page);
    const root = await laneRoot(page);
    if (!root) test.skip(true, `${route} drew no operations page for this user.`);

    // Classic: the page's own width and no glass-only part rendered.
    expect(await page.locator('[data-glass-only]:visible').count()).toBe(0);
    const classicWidth = await root!.evaluate((node) => getComputedStyle(node).maxWidth);
    expect(classicWidth).not.toBe('1480px');

    await page.evaluate((probe) => {
      const nodes = [
        document.querySelector('[data-glass-page="ops"]'),
        document.querySelector('[data-glass-page="ops"] h1'),
        document.querySelector('[data-glass-page="ops"] .bg-card, [data-glass-page="ops"] table'),
      ];
      nodes.forEach((node, i) => {
        if (node) (node as unknown as Record<string, unknown>)[probe] = i;
      });
    }, PROBE);
    const url = page.url();

    for (const look of SEQUENCE) {
      await chooseLook(page, look);
      await settle(page);
      const where = `after ${look.design} ${look.theme}`;
      expect(page.url(), `URL ${where}`).toBe(url);
      const kept = await page.evaluate((probe) => {
        const nodes = [
          document.querySelector('[data-glass-page="ops"]'),
          document.querySelector('[data-glass-page="ops"] h1'),
          document.querySelector('[data-glass-page="ops"] .bg-card, [data-glass-page="ops"] table'),
        ];
        return nodes.map((node) =>
          node ? ((node as unknown as Record<string, unknown>)[probe] ?? 'fresh') : 'none',
        );
      }, PROBE);
      expect(
        kept.filter((k) => k === 'fresh'),
        `no node replaced ${where}`,
      ).toEqual([]);
      if (look.design === 'liquid-glass') {
        const glass = await root!.evaluate((node) => ({
          width: getComputedStyle(node).maxWidth,
          form: node.getAttribute('data-glass-width'),
          title: getComputedStyle(node.querySelector('h1')!).fontSize,
        }));
        if (glass.form !== 'form') expect(glass.width, `page width ${where}`).toBe('1480px');
        expect(['26px', '24px'], `title size ${where}`).toContain(glass.title);
      } else {
        expect(await page.locator('[data-glass-only]:visible').count(), where).toBe(0);
        expect(await root!.evaluate((node) => getComputedStyle(node).maxWidth), where).toBe(
          classicWidth,
        );
      }
    }
  });
}

test('Cycle count history: the open status, a typed search and the URL survive every switch, with no data request', async ({
  page,
}) => {
  await page.goto('/dashboard/cycle-counts?status=completed');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const search = page.getByRole('search').getByRole('searchbox').first();
  if (!(await search.isVisible().catch(() => false)))
    test.skip(true, 'No cycle count history to search in this organisation.');
  await search.fill('north');
  await settle(page);
  const url = page.url();
  const requests = await watchDataRequests(page);
  requests.reset();

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(page.url(), `URL ${where}`).toBe(url);
    await expect(search).toHaveValue('north');
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }
});

/** Opens the first cycle count in progress, or skips. */
async function openCountInProgress(page: Page): Promise<void> {
  await page.goto('/dashboard/cycle-counts?status=in_progress');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const first = page.locator('[data-glass-page="ops"] table tbody tr a').first();
  if (!(await first.isVisible().catch(() => false)))
    test.skip(true, 'No cycle count in progress in this organisation.');
  await first.click();
  await expect(page.locator('[data-glass-view="cycle-count"]')).toBeVisible();
}

test('A cycle count: a typed count stays through every switch; Review & post stays open with focus through switches made in another tab', async ({
  page,
  context,
}) => {
  await openCountInProgress(page);
  await ready(page);
  const field = page.locator('[data-glass-view="cycle-count"] table tbody input').first();
  if (!(await field.isEnabled().catch(() => false)))
    test.skip(true, 'This user cannot count the open cycle count.');
  await field.fill('7');
  await settle(page);
  const requests = await watchDataRequests(page);
  requests.reset();
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    await expect(field).toHaveValue('7');
  }

  const post = page.getByRole('button', { name: /Review & post/u });
  if (!(await post.isEnabled().catch(() => false)))
    test.skip(true, 'Review & post is not offered for this count.');
  const remote = await openRemote(context);
  await post.click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      `focus inside Review & post after ${look.design} ${look.theme}`,
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(post).toBeFocused();
});

test('A purchase order: the Receive dialog keeps its typed quantity, and focus inside it, through switches made in another tab', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/purchase-orders');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const rows = page.locator('table[data-slot="po-list"] tbody tr a');
  const count = Math.min(await rows.count(), 10);
  let found = false;
  for (let i = 0; i < count && !found; i += 1) {
    await page.goto('/dashboard/purchase-orders');
    await rows.nth(i).click();
    await expect(page.locator('[data-glass-view="purchase-order"]')).toBeVisible();
    found = await page
      .getByRole('button', { name: 'Receive items' })
      .isVisible()
      .catch(() => false);
  }
  if (!found) test.skip(true, 'No purchase order with lines to receive in this organisation.');

  const remote = await openRemote(context);
  await page.getByRole('button', { name: 'Receive items' }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  const quantity = dialog.getByRole('spinbutton').first();
  await quantity.fill('1');
  const requests = await watchDataRequests(page);
  requests.reset();
  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(dialog).toBeVisible();
    await expect(quantity).toHaveValue('1');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      `focus inside Receive ${where}`,
    ).toBe(true);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('A return: the Next step actions and the scroll survive every switch, with no data request', async ({
  page,
}) => {
  await page.goto('/dashboard/returns');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const first = page.locator('[data-glass-view="returns"] table tbody tr a').first();
  if (!(await first.isVisible().catch(() => false)))
    test.skip(true, 'No return in this organisation.');
  await first.click();
  await expect(page.locator('[data-glass-view="return"]')).toBeVisible();
  await ready(page);
  const next = page.getByRole('region', { name: 'Next step' });
  const actionsBefore = await next.getByRole('button').allInnerTexts();
  const pane = page.locator('main#main-content');
  await pane.evaluate((main) => {
    main.scrollTop = Math.min(160, main.scrollHeight - main.clientHeight);
  });
  await settle(page);
  const scrollBefore = await pane.evaluate((main) => main.scrollTop);
  const requests = await watchDataRequests(page);
  requests.reset();

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(await next.getByRole('button').allInnerTexts(), `actions ${where}`).toEqual(
      actionsBefore,
    );
    expect(
      Math.abs((await pane.evaluate((main) => main.scrollTop)) - scrollBefore),
    ).toBeLessThanOrEqual(4);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }
});
