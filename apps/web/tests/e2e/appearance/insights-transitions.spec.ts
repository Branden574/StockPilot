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
  toastTexts,
  watchDataRequests,
  watchRealtimeJoins,
} from './look';

/**
 * TRANSITIONS ON THE INSIGHTS LANE (brief section 13; plan 8.2 cases 1 to 3).
 * Through Dark, Liquid Glass (Night, then Day), Light and Dark:
 *  - The Reports hub: the URL and the pane's scroll (within 4 px) stay; no
 *    data request is made (switch-requests.ts: the account save and no other
 *    server action, the Design cookie route and the scene photo only); no
 *    realtime channel is joined again; no toast appears twice.
 *  - Book Order Totals' Orders placed range: with the popover open and a
 *    start date typed, the switch is made in a second tab (the provider
 *    follows the stored choice, so the popover keeps its focus); it stays
 *    open with the typed date, focus stays inside it, no data request is
 *    made, Escape still closes it and focus returns to the field that
 *    opened it.
 *  - Book Order Totals' orders behind a total: with the drawer open, the
 *    switch is made in a second tab; the drawer stays open on the same URL
 *    with focus inside it and asks for nothing again; Escape closes it.
 *  - A page people open from a link (order tracking, /r/track): what was
 *    typed into its three fields stays through switches made in a second
 *    tab, with no data request.
 *
 * Needs a running server and a signed-in lab manager in an organisation with
 * Books ordered (for the drawer): the integrator's lab run. Each test skips,
 * with its reason, where the lab has no such record or the user is not
 * offered the control; every test skips in a build without Liquid Glass.
 */

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

async function openBookOrderTotals(page: Page): Promise<void> {
  await page.goto('/dashboard/reports/book-order-totals');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if ((await page.locator('[data-glass-view="book-order-totals"]').count()) === 0)
    test.skip(true, 'Book Order Totals is not offered to this user (Books off, or no access).');
}

test('Reports hub: the URL and the scroll survive every switch, with no data request, no new realtime join and no repeated toast', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  await page.goto('/dashboard/reports');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const pane = page.locator('main#main-content');
  await pane.evaluate((main) => {
    main.scrollTop = Math.min(160, main.scrollHeight - main.clientHeight);
  });
  await settle(page);

  const url = page.url();
  const scrollBefore = await pane.evaluate((main) => main.scrollTop);
  const toastsBefore = await toastTexts(page);
  const joinsBefore = joins.count();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(page.url(), `URL ${where}`).toBe(url);
    expect(
      Math.abs((await pane.evaluate((main) => main.scrollTop)) - scrollBefore),
      `scroll ${where}`,
    ).toBeLessThanOrEqual(4);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(joins.count(), `realtime joins ${where}`).toBe(joinsBefore);
    const toasts = await toastTexts(page);
    expect(new Set(toasts).size, 'no toast twice').toBe(toasts.length);
    expect(toasts.filter((t) => !toastsBefore.includes(t))).toEqual([]);
  }
});

test('Book Order Totals: the Orders placed range stays open with the typed date and its focus through switches made in another tab', async ({
  page,
  context,
}) => {
  await openBookOrderTotals(page);
  await ready(page);
  const remote = await openRemote(context);

  const opener = page.getByRole('button', { name: /^Start date/u });
  await opener.click();
  const range = page.getByRole('dialog', { name: 'Orders placed' });
  await expect(range).toBeVisible();
  const typed = range.getByLabel('Start date');
  await typed.fill('2026-09-01');
  await expect(typed).toHaveValue('2026-09-01');
  await settle(page);
  const url = page.url();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(range, `open ${where}`).toBeVisible();
    await expect(typed, `typed date ${where}`).toHaveValue('2026-09-01');
    expect(
      await range.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the range ${where}`,
    ).toBe(true);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(page.url(), `URL ${where}`).toBe(url);
  }

  await page.keyboard.press('Escape');
  await expect(range).toBeHidden();
  await expect(opener).toBeFocused();
  // Cancelled: the report asked for nothing.
  expect(page.url()).toBe(url);
});

test('Book Order Totals: the orders behind a total stay open with focus through switches made in another tab', async ({
  page,
  context,
}) => {
  await openBookOrderTotals(page);
  await ready(page);
  const view = page.getByRole('button', { name: /^View orders for /u }).first();
  if (!(await view.isVisible().catch(() => false)))
    test.skip(true, 'No book ordered in this organisation for the default range.');
  const remote = await openRemote(context);

  await view.click();
  const drawer = page.locator('[data-glass-role="bot-orders-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('table')).toBeVisible();
  await settle(page);
  const url = page.url();
  expect(url).toContain('view=');
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(drawer, `open ${where}`).toBeVisible();
    expect(
      await drawer.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the drawer ${where}`,
    ).toBe(true);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(page.url(), `URL ${where}`).toBe(url);
  }

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('Order tracking (a page opened from a link): typed fields survive every switch made in another tab, with no data request', async ({
  page,
  context,
}) => {
  await page.goto('/r/track');
  await expect(page.locator('[data-glass-page="links"]')).toHaveCount(1);
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  const remote = await openRemote(context);
  await chooseLookElsewhere(remote, page, START);

  const id = page.getByLabel('Request ID');
  const email = page.getByLabel('Email');
  const key = page.getByLabel('Tracking link key');
  await id.fill('0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d');
  await email.fill('requester@example.test');
  if (await key.isVisible().catch(() => false)) await key.fill('example-key');
  await settle(page);
  const url = page.url();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(id, `request ID ${where}`).toHaveValue('0b6f3c1e-1d2a-4c55-9f1e-6a1f0e3b2c4d');
    await expect(email, `email ${where}`).toHaveValue('requester@example.test');
    if (await key.isVisible().catch(() => false))
      await expect(key, `key ${where}`).toHaveValue('example-key');
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(page.url(), `URL ${where}`).toBe(url);
  }
});
