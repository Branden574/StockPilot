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
 * TRANSITIONS ON THE ADMIN LANE (brief section 13; plan 8.2 cases 1 to 3):
 * settings, the admin pages and the platform console, through Dark, Liquid
 * Glass (Night, then Day), Light and Dark.
 *  - Settings > Profile: an unsaved name stays in its field; the sub-nav
 *    still marks the page; the URL stays; no data request (the account save,
 *    the Design cookie route and the scene photo only); no realtime channel
 *    joined again; no toast twice.
 *  - Settings at phone width: the sub-nav's menu, opened, stays open with
 *    the same links (the switch is made in a second tab, so nothing on this
 *    page is clicked).
 *  - Admin > Warehouses: the New warehouse dialog stays open with its typed
 *    name and keeps focus through switches made in a second tab; Escape still
 *    closes it and focus returns to its trigger.
 *  - The platform console (no appearance menu of its own: every switch is
 *    made in a second tab): the directory's typed search stays; on an
 *    organization's Users tab the Order items access dialog stays open with
 *    the option chosen, and Escape still closes it.
 *
 * Needs a running server and a signed-in lab user who is an organization
 * admin; the console cases also need that user on the platform allowlist at
 * the two-step level, and skip when /platform answers 404. The integrator's
 * lab run. Skips in a build without Liquid Glass.
 */

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

/** The platform console has no header menu: the look is set from a second tab. */
async function readyElsewhere(page: Page, remote: Page): Promise<void> {
  if (!(await glassBuild(remote))) test.skip(true, 'This build does not offer Liquid Glass.');
  await chooseLookElsewhere(remote, page, START);
}

async function consoleOpen(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  if (!response || response.status() === 404) {
    test.skip(true, 'This lab user is not a platform admin at the two-step level.');
  }
  await expect(page.locator('[data-glass-page="platform"]')).toBeVisible();
}

test('Settings > Profile: an unsaved name, the sub-nav mark and the URL survive every switch, with no data request, no new realtime join and no repeated toast', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  await page.goto('/dashboard/settings/profile');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const name = page.locator('#profile-name');
  await expect(name).toBeVisible();
  const typed = `${await name.inputValue()} (unsaved draft)`;
  await name.fill(typed);
  const current = page
    .getByRole('navigation', { name: 'Settings' })
    .locator('a[aria-current="page"]');
  const currentHref = await current.first().getAttribute('href');
  const url = page.url();
  const toastsBefore = await toastTexts(page);
  const joinsBefore = joins.count();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    await expect(name).toHaveValue(typed);
    expect(page.url(), `URL after ${look.design} ${look.theme}`).toBe(url);
    expect(await current.first().getAttribute('href')).toBe(currentHref);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
    expect(joins.count()).toBe(joinsBefore);
    const toasts = await toastTexts(page);
    expect(new Set(toasts).size, 'no toast twice').toBe(toasts.length);
    expect(toasts.filter((t) => !toastsBefore.includes(t))).toEqual([]);
  }
});

test('Settings at phone width: the open sub-nav menu stays open with the same links through switches made in another tab', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/settings/notifications');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const remote = await openRemote(context);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  const toggle = nav.locator('button[aria-expanded]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const links = async () =>
    nav.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  const before = await links();
  expect(before.length).toBeGreaterThan(2);
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await links()).toEqual(before);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }
  // The page never scrolls sideways at phone width, in any look.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await remote.close();
});

test('Admin > Warehouses: the New warehouse dialog stays open with its name and focus through switches made in another tab; Escape closes it and focus returns', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/admin/warehouses');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const open = page.getByRole('button', { name: /^New / });
  if (!(await open.isVisible().catch(() => false))) test.skip(true, 'This user cannot add one.');
  const remote = await openRemote(context);

  await open.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const field = dialog.locator('#wh-name');
  await field.fill('Example annex (unsaved)');
  await field.focus();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue('Example annex (unsaved)');
    await expect(field).toBeFocused();
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await remote.close();
});

test('Platform directory: the typed search, the URL and the table survive every switch made in another tab, with no data request', async ({
  page,
  context,
}) => {
  const remote = await openRemote(context);
  await consoleOpen(page, '/platform');
  await readyElsewhere(page, remote);
  const search = page.getByRole('searchbox', { name: 'Search organizations' });
  await search.fill('example');
  const rows = await page
    .getByRole('region', { name: 'Organizations' })
    .locator('tbody tr')
    .count();
  const url = page.url();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(search).toHaveValue('example');
    expect(page.url()).toBe(url);
    expect(
      await page.getByRole('region', { name: 'Organizations' }).locator('tbody tr').count(),
    ).toBe(rows);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }
  await remote.close();
});

test('Platform organization: the Order items access dialog stays open with the option chosen through switches made in another tab; Escape closes it', async ({
  page,
  context,
}) => {
  const remote = await openRemote(context);
  await consoleOpen(page, '/platform');
  await readyElsewhere(page, remote);
  const org = page
    .getByRole('region', { name: 'Organizations' })
    .locator('tbody a[href^="/platform/orgs/"]')
    .first();
  if (!(await org.isVisible().catch(() => false))) test.skip(true, 'No organizations.');
  const href = await org.getAttribute('href');
  await page.goto(`${href!.split('?')[0]}?tab=users`);
  const menu = page.getByRole('button', { name: 'User actions' }).first();
  if (!(await menu.isVisible().catch(() => false))) test.skip(true, 'No members.');
  await menu.click();
  const item = page.getByRole('menuitem', { name: /Order items access/u });
  if (!(await item.isVisible().catch(() => false))) {
    test.skip(true, 'This member has no Order items access entry.');
  }
  await item.click();
  const dialog = page.getByRole('dialog', { name: /order items access/i });
  await expect(dialog).toBeVisible();
  const radios = dialog.getByRole('radio');
  const unchosen = radios.and(page.locator(':not(:checked)')).first();
  await unchosen.check();
  const chosen = await dialog.getByRole('radio', { checked: true }).getAttribute('value');
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(dialog).toBeVisible();
    expect(await dialog.getByRole('radio', { checked: true }).getAttribute('value')).toBe(chosen);
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the dialog after ${look.design} ${look.theme}`,
    ).toBe(true);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await remote.close();
});
