import { expect, test, type Page } from '@playwright/test';

import { actionsOf } from './ops-aria-actions';
import { chooseLook, glassBuild, SEQUENCE, settle, settleIntroNotice, START } from './orders-look';

/**
 * THE ACTION INVENTORY OF THE OPERATIONS LANE (plan 8.5; stage 4, lane L1).
 * On every page the lane composes, the actions inside the page (each link,
 * button, field, tab, menu item and option the accessibility tree holds
 * under the lane's root, data-glass-page="ops": its role, its accessible
 * name and, for a link, its target; ops-aria-actions.ts reads them) are the
 * same in Classic Dark, Liquid Glass Night, Liquid Glass Day and Classic
 * Light: glass adds none and loses none, and a doubled or a dropped one
 * shows. The lane's glass-only parts (a count's fifth figure and wide bar, a
 * purchase order's receiving summary and line columns, a return's progress
 * rail) hold no action, so no action is allowlisted on these routes; any
 * difference is a defect. The shell around the page (sidebar, top bar, the
 * appearance menu, with its allowlisted glass parts) belongs to the shell
 * lanes and is left out.
 *
 * Needs a running server and a signed-in lab user (storageState from
 * auth.setup.ts): the integrator's lab run. Plan 8.5 asks for it per role,
 * so the run repeats it signed in as each role (admin, manager, staff,
 * viewer: TEST_USER_EMAIL per role). A route this user cannot open (a
 * module that is off, a refusal) or with no record to show is skipped with
 * its reason; every test skips in a build without Liquid Glass.
 */

async function pageActions(page: Page): Promise<string[]> {
  return actionsOf(await page.locator('[data-glass-page="ops"]').first().ariaSnapshot());
}

/** The first heading is on screen: the page has drawn. */
async function drawn(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

/** The paths of the page's own links (in main) that `pattern` matches. */
async function linkedPaths(page: Page, pattern: RegExp): Promise<string[]> {
  const hrefs = await page
    .locator('main a[href]')
    .evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href));
  return [...new Set(hrefs.map((href) => new URL(href).pathname))].filter((path) =>
    pattern.test(path),
  );
}

/** Classic Dark first, then every look of the sequence: each inventory is Classic Dark's. */
async function compareOn(page: Page, what: string): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
  await settle(page);
  if ((await page.locator('[data-glass-page="ops"]').count()) === 0)
    test.skip(true, `${what} drew no operations page for this user.`);
  const classic = await pageActions(page);
  expect(classic.length, `${what}: an action in Classic`).toBeGreaterThan(0);
  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    expect(
      await pageActions(page),
      `${what}: the same actions in ${look.design} ${look.theme} as in Classic Dark`,
    ).toEqual(classic);
  }
}

/** Every route the lane composes that needs no record. */
const ROUTES = [
  '/dashboard/cycle-counts',
  '/dashboard/cycle-counts/new',
  '/dashboard/exceptions',
  '/dashboard/movements',
  '/dashboard/returns',
  '/dashboard/rentals',
  '/dashboard/rentals/new',
  '/dashboard/rentals/items/new',
  '/dashboard/bundles',
  '/dashboard/bundles/new',
  '/dashboard/schedule',
  '/dashboard/schedule/new',
  '/dashboard/customers',
  '/dashboard/maintenance',
  '/dashboard/maintenance/new',
  '/dashboard/procedures',
  '/dashboard/procedures/new',
  '/dashboard/purchase-orders',
  '/dashboard/purchase-orders/new',
  '/dashboard/purchase-orders/imports',
  '/dashboard/purchase-orders/imports/new',
  '/dashboard/purchase-orders/recurring',
  '/dashboard/planning',
  '/dashboard/suppliers',
  '/dashboard/locations',
  '/dashboard/categories',
  '/dashboard/tags',
] as const;

for (const route of ROUTES) {
  test(`${route}: the same actions in Classic and in Liquid Glass`, async ({ page }) => {
    await page.goto(route);
    await drawn(page);
    await compareOn(page, route);
  });
}

const ID = '[0-9a-f-]{36}';

/** A record page of the lane's, and the list that links to it. */
const RECORDS: Array<{ list: string; record: RegExp }> = [
  {
    list: '/dashboard/cycle-counts?status=in_progress',
    record: new RegExp(`^/dashboard/cycle-counts/${ID}$`, 'u'),
  },
  {
    list: '/dashboard/cycle-counts?status=completed',
    record: new RegExp(`^/dashboard/cycle-counts/${ID}$`, 'u'),
  },
  {
    list: '/dashboard/purchase-orders',
    record: new RegExp(`^/dashboard/purchase-orders/${ID}$`, 'u'),
  },
  {
    list: '/dashboard/purchase-orders/imports',
    record: new RegExp(`^/dashboard/purchase-orders/imports/${ID}$`, 'u'),
  },
  { list: '/dashboard/returns', record: new RegExp(`^/dashboard/returns/${ID}$`, 'u') },
  { list: '/dashboard/exceptions', record: new RegExp(`^/dashboard/exceptions/${ID}$`, 'u') },
  { list: '/dashboard/rentals', record: new RegExp(`^/dashboard/rentals/${ID}$`, 'u') },
  { list: '/dashboard/bundles', record: new RegExp(`^/dashboard/bundles/${ID}$`, 'u') },
  { list: '/dashboard/schedule', record: new RegExp(`^/dashboard/schedule/${ID}$`, 'u') },
  { list: '/dashboard/maintenance', record: new RegExp(`^/dashboard/maintenance/${ID}$`, 'u') },
  { list: '/dashboard/procedures', record: new RegExp(`^/dashboard/procedures/${ID}$`, 'u') },
  { list: '/dashboard/locations', record: new RegExp(`^/dashboard/locations/${ID}$`, 'u') },
  // A warehouse's page is the lane's; the admin list (another lane's) links to it.
  { list: '/dashboard/admin/warehouses', record: new RegExp(`^/dashboard/warehouses/${ID}$`, 'u') },
];

for (const { list, record } of RECORDS) {
  test(`The first record ${list} links to: the same actions in Classic and in Liquid Glass`, async ({
    page,
  }) => {
    await page.goto(list);
    await drawn(page);
    const [path] = await linkedPaths(page, record);
    if (!path) test.skip(true, `No record to open from ${list} for this user.`);
    await page.goto(path!);
    await drawn(page);
    await compareOn(page, path!);
  });
}

/** The lists whose records have an edit page of the lane's (`<record>/edit`). */
const EDITABLE: Array<{ list: string; record: RegExp }> = RECORDS.filter(({ list }) =>
  [
    '/dashboard/purchase-orders',
    '/dashboard/bundles',
    '/dashboard/schedule',
    '/dashboard/procedures',
  ].includes(list),
);

for (const { list, record } of EDITABLE) {
  test(`The edit page of the first record ${list} links to that this user can edit: the same actions in Classic and in Liquid Glass`, async ({
    page,
  }) => {
    await page.goto(list);
    await drawn(page);
    let edit: string | null = null;
    // A purchase order is editable only as a draft: look through a few.
    for (const path of (await linkedPaths(page, record)).slice(0, 8)) {
      await page.goto(path);
      await drawn(page);
      if ((await linkedPaths(page, /\/edit$/u)).includes(`${path}/edit`)) {
        edit = `${path}/edit`;
        break;
      }
    }
    if (!edit) test.skip(true, `No record from ${list} this user can edit.`);
    await page.goto(edit!);
    await drawn(page);
    await compareOn(page, edit!);
  });
}
