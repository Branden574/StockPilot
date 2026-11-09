import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  openFirstOrder,
  settleIntroNotice,
  waitForLook,
} from './orders-look';

/**
 * THE PHONE LAYOUTS (Liquid Glass fidelity lane phone; Items-Mobile,
 * Order-Detail-Mobile and Order-New-Mobile at 390 x 844). At 760 px and
 * under, glass lays the SAME nodes out as the boards' phone screens:
 *
 *  - Items and Books: the table as one card per record (no sideways scroll),
 *    the views row and the filters as one scrolling row each under the
 *    search, the selection bar floating at the foot;
 *  - an order page: the lines table as the phone line list, and Manager
 *    actions' own step that moves the order on fixed in the bottom
 *    next-step bar;
 *  - Place an order: the steps and the order setup on one line each, and
 *    the cart bar at the foot (the floating cart button and the cart's own
 *    Review order button).
 *
 * Nothing is submitted: a row is ticked and unticked, one product is added
 * to the cart and the cart is emptied again; no step button is pressed.
 * Classic at the same width keeps today's table (checked last).
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts) who can approve orders: the integrator's lab run (stage 5).
 * A build without Liquid Glass skips; a route with nothing to show skips
 * with the reason.
 */

test.use({ viewport: { width: 390, height: 844 } });

const DAY_GLASS = { design: 'liquid-glass', theme: 'light' } as const;

async function glass(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, DAY_GLASS);
  await waitForLook(page, DAY_GLASS);
}

/** No sideways scroll on the page itself. */
async function noPageOverflow(page: Page): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(client);
}

for (const [route, root] of [
  ['/dashboard/inventory', 'items'],
  ['/dashboard/books', 'books'],
] as const) {
  test(`${route}: one card per record, the filters in one scrolling row, the bar at the foot`, async ({
    page,
  }) => {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await glass(page);
    const table = page.locator(`[data-glass-page="${root}"] [data-glass="items-table"]`);
    if (!(await table.isVisible().catch(() => false)))
      test.skip(true, 'No records, or the Grid view is chosen.');
    await noPageOverflow(page);
    const cards = table.locator(':scope > tbody > tr');
    expect(await cards.count()).toBeGreaterThan(0);
    const first = cards.first();
    expect(await first.evaluate((tr) => getComputedStyle(tr).display)).toBe('flex');
    // Every card lies inside the screen's width.
    const boxes = await cards.evaluateAll((trs) =>
      trs.slice(0, 10).map((tr) => {
        const b = tr.getBoundingClientRect();
        return [b.left, b.right];
      }),
    );
    for (const [left, right] of boxes) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(390);
    }
    // Every control of the list has a box (none was hidden).
    const hidden = await table.evaluate((t) =>
      [...t.querySelectorAll('button, a[href], [role="checkbox"], input')]
        .filter((c) => c.getClientRects().length === 0)
        .map((c) => c.getAttribute('aria-label') ?? c.textContent ?? c.tagName),
    );
    expect(hidden).toEqual([]);
    // The search over the filters; the filters scroll sideways in one row.
    const toolbar = page.locator(`[data-glass-page="${root}"] [data-glass="items-toolbar"]`);
    expect(await toolbar.evaluate((e) => getComputedStyle(e).overflowX)).toBe('auto');
    // Tick a record: the bar floats at the foot, inside the screen; untick.
    const box = first.locator('td:first-child [role="checkbox"]');
    if (await box.isVisible().catch(() => false)) {
      await box.click();
      const layer = page.locator(`[data-glass-page="${root}"] [data-glass="selbar-layer"]`);
      await expect(layer).toHaveAttribute('data-glass-state', 'open');
      const b = await layer.boundingBox();
      expect(b).not.toBeNull();
      expect(b!.y + b!.height).toBeLessThanOrEqual(844);
      expect(b!.x).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
      await box.click();
      await expect(layer).toHaveAttribute('data-glass-state', 'closed');
    }
  });
}

test('An order page: the phone line list and the bottom next-step bar', async ({ page }) => {
  if (!(await openFirstOrder(page, 'all_active'))) test.skip(true, 'No open orders.');
  await glass(page);
  await noPageOverflow(page);
  const scroll = page.locator('[data-glass-role="order-lines"] [data-glass="table-scroll"]');
  const [sw, cw] = await scroll.evaluate((e) => [e.scrollWidth, e.clientWidth]);
  expect(sw, 'the lines do not scroll sideways').toBeLessThanOrEqual(cw);
  const row = page.locator('[data-glass-role="order-lines"] [data-glass="table"] tbody tr').first();
  expect(await row.evaluate((tr) => getComputedStyle(tr).display)).toBe('flex');
  const step = page.locator(
    '[data-testid="manager-actions-buttons"] > [data-glass-variant="default"]',
  );
  if ((await step.count()) === 0) {
    // No step to take (or not an approver): no bar.
    return;
  }
  const first = step.first();
  expect(await first.evaluate((b) => getComputedStyle(b).position)).toBe('fixed');
  const b = await first.boundingBox();
  expect(b).not.toBeNull();
  expect(b!.y + b!.height).toBeLessThanOrEqual(844);
  expect(b!.y).toBeGreaterThan(844 - 90);
  const bar = await page.locator('[data-testid="manager-actions-buttons"]').evaluate((r) => {
    const a = getComputedStyle(r, '::after');
    return [a.position, a.left, a.right, a.height];
  });
  expect(bar).toEqual(['fixed', '12px', '12px', '60px']);
});

test('Place an order: steps and setup on one line, the cart bar at the foot', async ({ page }) => {
  await page.goto('/dashboard/orders/new');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (
    !(await page
      .locator('.sp-storefront')
      .isVisible()
      .catch(() => false))
  )
    test.skip(true, 'No warehouse to order from in this organisation.');
  await glass(page);
  await noPageOverflow(page);
  const flow = await page.locator('.sf-flow').boundingBox();
  expect(flow!.height, 'the steps on one line').toBeLessThanOrEqual(24);
  const setup = await page.locator('.sf-page > .sf-setup').boundingBox();
  expect(setup!.height, 'the setup on one line').toBeLessThanOrEqual(80);
  const add = page.getByRole('button', { name: /Add to cart/ }).first();
  if (!(await add.isVisible().catch(() => false)))
    test.skip(true, 'Nothing to add in this catalog.');
  await add.click();
  const fab = page.locator('.sf-fab');
  await expect(fab).toHaveAttribute('data-show', 'true');
  const bar = await fab.boundingBox();
  expect(bar).toEqual(expect.objectContaining({ x: 12, width: 366, height: 60 }));
  const review = await page.locator('.sf-cart-foot .sf-submit').boundingBox();
  expect(review!.x).toBeGreaterThan(bar!.x);
  expect(review!.x + review!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
  expect(review!.y).toBeGreaterThanOrEqual(bar!.y);
  expect(review!.y + review!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
  // Empty the cart again (nothing was sent): Clear all, then its confirm.
  await page.locator('.sf-cart-head .clr').click();
  await page.locator('.sf-cart-confirm .clr').first().click();
  await expect(fab).toHaveAttribute('data-show', 'false');
});

test('Classic at 390 px keeps today’s sideways table', async ({ page }) => {
  await page.goto('/dashboard/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  const look = { design: 'classic', theme: 'light' } as const;
  await chooseLook(page, look);
  await waitForLook(page, look);
  const table = page.locator('[data-glass="items-table"]');
  if (!(await table.isVisible().catch(() => false))) test.skip(true, 'No records.');
  expect(await table.evaluate((t) => getComputedStyle(t).display)).toBe('table');
  expect(
    await table
      .locator('tbody tr')
      .first()
      .evaluate((tr) => getComputedStyle(tr).display),
  ).toBe('table-row');
});
