import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  chooseLookElsewhere,
  glassBuild,
  openFirstOrder,
  openRemote,
  SEQUENCE,
  settle,
  settleIntroNotice,
  START,
  toastTexts,
  watchDataRequests,
  watchRealtimeJoins,
} from './orders-look';

/**
 * TRANSITIONS ON THE ORDERS LANE (brief section 13; plan 8.2 cases 1 to 3).
 * Through Dark, Liquid Glass (Night, then Day), Light and Dark:
 *  - The Orders list: the open tab, the URL and the pane's scroll (within
 *    4 px) stay; no data request is made (the account save, the Design
 *    cookie route and the scene photo only); no realtime channel is joined
 *    again; no toast appears twice.
 *  - Place an order: the cart's lines and units and a typed search stay;
 *    with the review sheet open the switch is made in a second tab, and the
 *    sheet stays open with focus inside it.
 *  - An order's page: unsaved internal notes stay in their field; with the
 *    Deny dialog open and a reason typed, the switch is made in a second tab
 *    (the provider follows the stored choice), so the dialog keeps its
 *    focus; it stays open with the reason, focus stays inside it, Escape
 *    still closes it and focus returns to Deny. The page's realtime channel
 *    is never joined again.
 *  - Manage order items: ticked rows and the open Review selection sheet
 *    stay through switches made in a second tab; Escape closes the sheet and
 *    focus returns to Review selection.
 *  - The digital pick: a typed, unsaved quantity stays in its field.
 *
 * Needs a running server and a signed-in lab user who can approve orders and
 * manage order items, in an organisation with orders in each state the
 * tests name: the integrator's lab run. Each test skips, with its reason,
 * where the lab has no such record or the user is not offered the control;
 * every test skips in a build without Liquid Glass.
 */

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

test('Orders list: the open tab, the URL and the scroll survive every switch, with no data request, no new realtime join and no repeated toast', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  await page.goto('/dashboard/orders?status=all_active');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const pane = page.locator('main#main-content');
  await pane.evaluate((main) => {
    main.scrollTop = Math.min(200, main.scrollHeight - main.clientHeight);
  });
  await settle(page);

  const current = page.locator('[data-slot="stat-strip-link"][aria-current="page"]');
  const tabBefore = await current.innerText();
  const url = page.url();
  const scrollBefore = await pane.evaluate((main) => main.scrollTop);
  const toastsBefore = await toastTexts(page);
  const joinsBefore = joins.count();
  const requests = watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(page.url(), `URL ${where}`).toBe(url);
    expect(await current.innerText(), `open tab ${where}`).toBe(tabBefore);
    expect(
      Math.abs((await pane.evaluate((main) => main.scrollTop)) - scrollBefore),
    ).toBeLessThanOrEqual(4);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(joins.count(), `realtime joins ${where}`).toBe(joinsBefore);
    const toasts = await toastTexts(page);
    expect(new Set(toasts).size, 'no toast twice').toBe(toasts.length);
    expect(toasts.filter((t) => !toastsBefore.includes(t))).toEqual([]);
  }
});

test('Place an order: the cart and a typed search survive every switch; the review sheet stays open with focus through switches made in another tab', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/orders/new');
  const storefront = page.locator('.sp-storefront');
  if (!(await storefront.isVisible().catch(() => false)))
    test.skip(true, 'No warehouse to order from in this organisation.');
  await ready(page);

  const add = page.getByRole('button', { name: /Add to cart/u });
  if ((await add.count()) < 2) test.skip(true, 'Needs at least two orderable items.');
  await add.nth(0).click();
  await add.nth(1).click();
  const search = page.getByRole('textbox', { name: 'Search catalog' });
  const totals = page.locator('.sf-cart-foot .sf-tot .v');
  await settle(page);
  const cartBefore = await totals.allInnerTexts();
  await search.fill('pa');
  await settle(page);
  const requests = watchDataRequests(page);
  requests.reset();

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(await totals.allInnerTexts(), `cart ${where}`).toEqual(cartBefore);
    await expect(search).toHaveValue('pa');
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }

  // The review sheet, open while the look changes in another tab.
  await search.fill('');
  await settle(page);
  const remote = await openRemote(context);
  await page.locator('.sf-submit').click();
  const review = page.getByRole('dialog').first();
  await expect(review).toBeVisible();
  requests.reset();
  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(review).toBeVisible();
    expect(
      await review.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the review after ${look.design} ${look.theme}`,
    ).toBe(true);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }
  await remote.close();
});

test('An order page: unsaved internal notes stay through every switch, with no second realtime join', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  if (!(await openFirstOrder(page, 'needs_approval')))
    test.skip(true, 'No order awaiting approval.');
  const notes = page.locator('#internal-notes');
  if (!(await notes.isVisible().catch(() => false)))
    test.skip(true, 'This user is not offered internal notes on that order.');
  await ready(page);
  const typed = `${await notes.inputValue()} (unsaved draft)`;
  await notes.fill(typed);
  await settle(page);
  const url = page.url();
  const joinsBefore = joins.count();
  const requests = watchDataRequests(page);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(notes).toHaveValue(typed);
    expect(page.url()).toBe(url);
    expect(joins.count(), `realtime joins ${where}`).toBe(joinsBefore);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }
});

test('An order page: the Deny dialog stays open with its reason and focus through switches made in another tab; Escape still closes it and focus returns to Deny', async ({
  page,
  context,
}) => {
  if (!(await openFirstOrder(page, 'needs_approval')))
    test.skip(true, 'No order awaiting approval.');
  const deny = page.getByRole('button', { name: 'Deny', exact: true });
  if (!(await deny.isVisible().catch(() => false)))
    test.skip(true, 'This user is not offered Deny on that order.');
  await ready(page);
  const remote = await openRemote(context);

  await deny.click();
  const dialog = page.getByRole('dialog', { name: 'Deny this request?' });
  await expect(dialog).toBeVisible();
  const reason = dialog.getByLabel('Reason');
  await reason.fill('Lab check: not sent');
  await reason.focus();
  const requests = watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(dialog).toBeVisible();
    await expect(reason).toHaveValue('Lab check: not sent');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the dialog ${where}`,
    ).toBe(true);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }

  // Never sent: Escape closes it, and focus returns to Deny.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(deny).toBeFocused();
  await remote.close();
});

test('Manage order items: ticked rows and the open Review selection sheet stay through switches made in another tab; Escape closes it and focus returns', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/orders/manage-items');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const rows = page.getByRole('table').getByRole('checkbox', { name: /^Select (?!every)/u });
  if ((await rows.count()) < 2)
    test.skip(true, 'This user cannot manage order items, or there are fewer than two.');
  await ready(page);
  const remote = await openRemote(context);

  await rows.nth(0).click();
  await rows.nth(1).click();
  const bar = page.getByRole('region', { name: 'Selection' });
  await expect(bar).toContainText('2 selected');
  const open = bar.getByRole('button', { name: 'Review selection' });
  await open.click();
  const sheet = page.getByRole('dialog', { name: 'Review selection' });
  await expect(sheet).toBeVisible();
  const requests = watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('listitem')).toHaveCount(2);
    expect(
      await sheet.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the sheet ${where}`,
    ).toBe(true);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(open).toBeFocused();
  await expect(bar).toContainText('2 selected');
  await remote.close();
});

test('The digital pick: a typed, unsaved quantity stays in its field through every switch', async ({
  page,
}) => {
  if (!(await openFirstOrder(page, 'picking'))) test.skip(true, 'No order in picking.');
  const open = page.getByRole('link', { name: 'Open digital pick' });
  if (!(await open.isVisible().catch(() => false)))
    test.skip(true, 'This user is not offered the digital pick on that order.');
  await open.click();
  const field = page.getByRole('spinbutton', { name: /^Picked quantity for / }).first();
  if (!(await field.isVisible().catch(() => false)))
    test.skip(true, 'The pick is locked to another picker.');
  await ready(page);
  await field.fill('1');
  const url = page.url();
  const requests = watchDataRequests(page);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    await expect(field).toHaveValue('1');
    expect(page.url()).toBe(url);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }
});
