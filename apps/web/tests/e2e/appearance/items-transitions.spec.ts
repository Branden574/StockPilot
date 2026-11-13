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
 * TRANSITIONS ON THE ITEMS LANE (brief section 13; plan 8.2 cases 1 to 3).
 * Through Dark, Liquid Glass (Night, then Day), Light and Dark:
 *  - Items: the ticked rows, an expanded display group and the pane's scroll
 *    (within 4 px) stay; the URL stays; no data request is made (the account
 *    save, the Design cookie route and the scene photo only); no realtime
 *    channel is joined again; no toast appears twice.
 *  - An item's edit form: an unsaved name stays in its field.
 *  - An item's page with the Adjust stock dialog open, and the command
 *    palette open with a query: the switch is made in a second tab (the
 *    provider follows the stored choice), so the dialog keeps its focus; it
 *    stays open with what was typed, focus stays inside it and Escape still
 *    closes it. Focus then returns to Adjust stock (its Radix trigger); the
 *    palette has no trigger (the launcher opens it), so there focus must land
 *    where it lands when the palette is closed without any switch.
 *
 * Needs a running server and a signed-in lab user who can adjust stock, in an
 * organisation with items: the integrator's lab run. Skips in a build
 * without Liquid Glass.
 */

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

interface ListState {
  url: string;
  ticked: string[];
  expanded: string[];
  scrollTop: number;
}

/** A group's own disclosure: the chevron in a header row of the table body
 *  (inventory-table.tsx HeaderChevron, on every row kind "header": a display
 *  group, a shared SKU, a size run). The 14-day column's mode menu in the
 *  table head also carries aria-expanded, and a look switch closes that menu
 *  as any click elsewhere does, so it is never read as a group. */
const GROUP_TOGGLE = 'tbody tr[data-row-kind="header"] button[aria-expanded]';

async function listState(page: Page): Promise<ListState> {
  return {
    url: page.url(),
    ticked: await page
      .getByRole('table')
      .getByRole('checkbox', { checked: true })
      .evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-label') ?? '')),
    expanded: await page
      .getByRole('table')
      .locator(`${GROUP_TOGGLE}[aria-expanded="true"]`)
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? '')),
    scrollTop: await page.locator('main#main-content').evaluate((main) => main.scrollTop),
  };
}

test('Items: ticked rows, an open group and the scroll survive every switch, with no data request, no new realtime join and no repeated toast', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  await page.goto('/dashboard/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);

  const rows = page.getByRole('table').getByRole('checkbox', { name: /^Select (?!all)/u });
  if ((await rows.count()) < 2) test.skip(true, 'Needs at least two items on the first page.');
  await rows.nth(0).click();
  await rows.nth(1).click();
  const closedGroup = page
    .getByRole('table')
    .locator(`${GROUP_TOGGLE}[aria-expanded="false"]`)
    .first();
  const openedGroup = await closedGroup.isVisible().catch(() => false);
  if (openedGroup) await closedGroup.click();
  await page.locator('main#main-content').evaluate((main) => {
    main.scrollTop = Math.min(240, main.scrollHeight - main.clientHeight);
  });
  await settle(page);

  const before = await listState(page);
  expect(before.ticked.length).toBeGreaterThanOrEqual(2);
  // The group opened above is the one the switches must keep open.
  if (openedGroup) expect(before.expanded.length).toBeGreaterThanOrEqual(1);
  const toastsBefore = await toastTexts(page);
  const joinsBefore = joins.count();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const after = await listState(page);
    expect(after.url, `URL after ${look.design} ${look.theme}`).toBe(before.url);
    expect(after.ticked).toEqual(before.ticked);
    expect(after.expanded).toEqual(before.expanded);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(4);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
    expect(joins.count()).toBe(joinsBefore);
    const toasts = await toastTexts(page);
    expect(new Set(toasts).size, 'no toast twice').toBe(toasts.length);
    expect(toasts.filter((t) => !toastsBefore.includes(t))).toEqual([]);
  }
  // The selection bar is still there, with every ticked row counted.
  await expect(page.getByText(`${before.ticked.length} selected`)).toBeVisible();
});

test('Item edit: an unsaved name stays in its field through every switch', async ({ page }) => {
  await page.goto('/dashboard/inventory');
  const link = page.getByRole('table').locator('tbody tr a[href^="/dashboard/inventory/"]').first();
  if (!(await link.isVisible().catch(() => false))) test.skip(true, 'No items.');
  const href = await link.getAttribute('href');
  await page.goto(`${href!.split('?')[0]}/edit`);
  const name = page.locator('#item-form-name');
  if (!(await name.isVisible().catch(() => false))) test.skip(true, 'This user cannot edit items.');
  await ready(page);
  const typed = `${await name.inputValue()} (unsaved draft)`;
  await name.fill(typed);
  const url = page.url();
  const requests = await watchDataRequests(page);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    await expect(name).toHaveValue(typed);
    expect(page.url()).toBe(url);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }
});

test('Item page: the Adjust stock dialog stays open with its quantity and focus through switches made in another tab; Escape still closes it and focus returns', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/inventory');
  const link = page.getByRole('table').locator('tbody tr a[href^="/dashboard/inventory/"]').first();
  if (!(await link.isVisible().catch(() => false))) test.skip(true, 'No items.');
  await link.click();
  await expect(page.locator('[data-glass-page="item-detail"]')).toBeVisible();
  await ready(page);
  const open = page.getByRole('button', { name: 'Adjust stock' });
  if (!(await open.isVisible().catch(() => false)))
    test.skip(true, 'This user cannot adjust stock.');
  const remote = await openRemote(context);

  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Adjust stock' });
  await expect(dialog).toBeVisible();
  const quantity = dialog.getByLabel('Quantity');
  await quantity.fill('3');
  await quantity.focus();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(dialog).toBeVisible();
    await expect(quantity).toHaveValue('3');
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
      `focus inside the dialog after ${look.design} ${look.theme}`,
    ).toBe(true);
    expect(requests.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await remote.close();
});

/** Where keyboard focus is: the body, or the focused control's accessible label or text. */
async function focusedControl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return 'body';
    return `${active.tagName.toLowerCase()}: ${active.getAttribute('aria-label') ?? active.textContent?.trim() ?? ''}`;
  });
}

test('Command palette: open with a query through switches made in another tab; Escape closes it and focus lands where it does without a switch', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);
  const remote = await openRemote(context);

  // The top bar's search opens it, as a person would. ⌘K is not used: from
  // a text field (the Items search) the launcher ignores it on purpose
  // (command-palette-launcher.tsx isPaletteChord). Whichever of the bar's two
  // "Open command palette" buttons the bar shows at this width is the one in
  // the accessibility tree.
  const opener = page.getByRole('button', { name: 'Open command palette' });
  const palette = page.getByRole('dialog', { name: 'Search' });

  // Without a switch first: where Escape leaves focus in this look. The
  // palette has no Radix trigger (the launcher opens it), so Radix hands
  // focus to no control when it closes; the switches must not change that.
  await opener.click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  const focusWithoutSwitch = await focusedControl(page);

  await opener.click();
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('lab');
  const requestsBefore = await watchDataRequests(page);
  // Typing searched; only the switches are measured from here.
  await settle(page);
  requestsBefore.reset();

  for (const look of SEQUENCE) {
    await chooseLookElsewhere(remote, page, look);
    await settle(page);
    await expect(palette).toBeVisible();
    await expect(input).toHaveValue('lab');
    await expect(input).toBeFocused();
    expect(requestsBefore.list(), `data requests after ${look.design} ${look.theme}`).toEqual([]);
  }

  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  expect(await focusedControl(page)).toBe(focusWithoutSwitch);
  await remote.close();
});
