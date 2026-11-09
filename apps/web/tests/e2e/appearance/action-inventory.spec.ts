import { expect, test, type Locator, type Page } from '@playwright/test';

import allowlistJson from './glass-only-allowlist.json';
import { chooseLook, glassBuild, settle, settleIntroNotice, START, type Look } from './look';
import { actionsOf } from './ops-aria-actions';
import {
  arriveWith,
  buildRollout,
  chooseLook as chooseSiteLook,
  MARKETING_PATHS,
  skipLandingIntro,
  waitForTwin,
} from './site-look';
import { stage5Role } from './stage5a-lib';
import {
  compareInventories,
  disclosuresToPress,
  menusToOpen,
  type Allowlist,
  type InventoryDiff,
} from './stage5a-actions';

/**
 * PROVES plan 8.5 "action inventory" for every lane the two earlier action
 * specs do not cover (ops-actions.spec.ts: the operations pages;
 * admin-actions.spec.ts: settings, admin and the platform console):
 * items and books (lists and record pages), the orders lane (Orders, Place
 * an order, an order, Manage order items), the insights lane (Reports, Book
 * Order Totals, a report, Team, Notifications, Help), the shell (Overview
 * with the sidebar, top bar and bell, and the account menu, the command
 * palette and the organisation switcher opened), the signed-out site and
 * auth pages, and the customer portal; per role: the run is repeated with
 * STAGE5_ROLE = admin, manager, staff, viewer, platform and portal (each
 * its storageState, .auth/stage5-<role>.json), and the signed-out run.
 *
 * The inventory is every action in the page's accessibility tree (role,
 * accessible name, a link's target: ops-aria-actions.ts), read in Classic
 * Dark and in Liquid Glass Night and Day. The rule (stage5a-actions.ts, unit
 * test src/test/stage5a-actions.test.ts) fails on a glass-only action not on
 * glass-only-allowlist.json for the route and width, on an allowlisted
 * duplicate whose classic twin is missing for this role, and on any classic
 * action missing in glass (apart from what an entry says glass replaces).
 * Before reading glass, the allowlist's disclosure buttons are pressed and,
 * at the widths where an entry moves an action into a menu, that menu is
 * opened and read.
 *
 * Lab command, per role (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=<role> \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/action-inventory.spec.ts
 * (the 390 project of the config repeats it at phone width). A route the
 * role cannot open, or with no record, skips with its reason.
 */

const ALLOWLIST = allowlistJson as unknown as Allowlist;
const GLASS: Look[] = [
  { design: 'liquid-glass', theme: 'dark' },
  { design: 'liquid-glass', theme: 'light' },
];

function width(page: Page): number {
  return page.viewportSize()?.width ?? 1280;
}

async function inventoryOf(scope: Locator): Promise<string[]> {
  return actionsOf(await scope.ariaSnapshot());
}

/** Presses every disclosure the allowlist names for this route and width (glass only). */
async function pressDisclosures(page: Page, path: string): Promise<void> {
  for (const entry of disclosuresToPress(ALLOWLIST, { path, width: width(page) })) {
    const buttons = page.locator(`${entry.selector}[aria-expanded="false"]`);
    for (let i = (await buttons.count()) - 1; i >= 0; i -= 1) {
      const button = buttons.nth(i);
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
      }
    }
  }
}

/** The items of the menus an entry moves actions into at this width, opened and read. */
async function menuItems(page: Page, path: string): Promise<string[]> {
  const out: string[] = [];
  if (menusToOpen(ALLOWLIST, { path, width: width(page) }).length === 0) return out;
  const trigger = page.locator('#user-menu-trigger');
  if (!(await trigger.isVisible().catch(() => false))) return out;
  await trigger.click();
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  out.push(...(await inventoryOf(menu)));
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return out;
}

function report(diff: InventoryDiff, where: string): void {
  if (diff.allowed.length) {
    test.info().annotations.push({
      type: 'allowlisted',
      description: `${where}: ${diff.allowed.join('; ')}`,
    });
  }
  expect(
    { extraInGlass: diff.extraInGlass, missingInGlass: diff.missingInGlass },
    `${where}: glass adds nothing unlisted and loses nothing`,
  ).toEqual({ extraInGlass: [], missingInGlass: [] });
}

/** Classic Dark, then Night and Day glass, for the page as it is now. */
async function comparePage(page: Page, choose: (look: Look) => Promise<void>): Promise<void> {
  const path = new URL(page.url()).pathname;
  await choose(START);
  await settle(page);
  const classic = await inventoryOf(page.locator('body'));
  expect(classic.length, `${path}: an action in Classic`).toBeGreaterThan(0);
  for (const look of GLASS) {
    await choose(look);
    await settle(page);
    await pressDisclosures(page, path);
    const glass = await inventoryOf(page.locator('body'));
    const menus = await menuItems(page, path);
    report(
      compareInventories(classic, glass, ALLOWLIST, { path, width: width(page) }, menus),
      `${path} (${process.env.STAGE5_ROLE ?? 'signed out'}, ${width(page)} px, ${look.design} ${look.theme})`,
    );
  }
  await choose(START);
}

async function dashboardReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
}

const ID = '[0-9a-f-]{36}';

/** Pages with no record: their own path. */
const DASHBOARD_ROUTES = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/orders/manage-items',
  '/dashboard/reports',
  '/dashboard/reports/book-order-totals',
  '/dashboard/reports/inventory-valuation',
  '/dashboard/team',
  '/dashboard/notifications',
  '/dashboard/help',
  '/dashboard/ai',
];

/** Record pages: the first one the list links to. */
const DASHBOARD_RECORDS = [
  { list: '/dashboard/inventory', record: new RegExp(`^/dashboard/inventory/${ID}$`, 'u') },
  { list: '/dashboard/books', record: new RegExp(`^/dashboard/books/${ID}$`, 'u') },
  {
    list: '/dashboard/orders?status=all_active',
    record: new RegExp(`^/dashboard/orders/${ID}$`, 'u'),
  },
];

test.describe('signed in: the items, orders and insights lanes and the shell', () => {
  test.beforeEach(() => {
    const role = stage5Role();
    test.skip(role === null || role === 'portal', 'Needs an organisation member’s run.');
  });

  for (const route of DASHBOARD_ROUTES) {
    test(`${route}: the same actions in Classic and in Liquid Glass`, async ({ page }) => {
      const response = await page.goto(route);
      if (!response || response.status() >= 400 || !page.url().includes(route.split('?')[0]!))
        test.skip(true, `${route} is not open to this role.`);
      await dashboardReady(page);
      await comparePage(page, (look) => chooseLook(page, look));
    });
  }

  for (const { list, record } of DASHBOARD_RECORDS) {
    test(`The first record ${list} links to: the same actions in Classic and in Liquid Glass`, async ({
      page,
    }) => {
      const response = await page.goto(list);
      if (!response || response.status() >= 400)
        test.skip(true, `${list} is not open to this role.`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const hrefs = await page
        .locator('main a[href]')
        .evaluateAll((links) => links.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
      const path = hrefs.find((p) => record.test(p));
      if (!path) test.skip(true, `No record to open from ${list} for this role.`);
      await page.goto(path!);
      await dashboardReady(page);
      await comparePage(page, (look) => chooseLook(page, look));
    });
  }

  const OVERLAYS: Array<{ name: string; open(page: Page): Promise<Locator | null> }> = [
    {
      name: 'the account menu',
      open: async (page) => {
        await page.locator('#user-menu-trigger').click();
        return page.getByRole('menu').first();
      },
    },
    {
      name: 'the command palette',
      open: async (page) => {
        await page.getByRole('button', { name: 'Open command palette' }).first().click();
        return page.getByRole('dialog', { name: 'Search' });
      },
    },
    {
      name: 'the organisation switcher',
      open: async (page) => {
        const trigger = page.getByRole('button', { name: 'Switch organization' });
        if (!(await trigger.isVisible().catch(() => false))) return null;
        await trigger.click();
        return page.getByRole('menu').first();
      },
    },
    {
      name: 'the appearance menu',
      open: async (page) => {
        await page.locator('#theme-toggle-trigger').first().click();
        return page.getByRole('menu').first();
      },
    },
  ];

  for (const overlay of OVERLAYS) {
    test(`Overview, ${overlay.name} opened: the same actions in Classic and in Liquid Glass`, async ({
      page,
    }) => {
      await page.goto('/dashboard');
      await dashboardReady(page);
      const read = async (): Promise<string[] | null> => {
        const scope = await overlay.open(page);
        if (!scope) return null;
        await expect(scope).toBeVisible();
        const list = await inventoryOf(scope);
        await page.keyboard.press('Escape');
        await expect(scope).toBeHidden();
        return list;
      };
      await chooseLook(page, START);
      await settle(page);
      const classic = await read();
      if (classic === null) test.skip(true, `${overlay.name}: not offered to this role.`);
      for (const look of GLASS) {
        await chooseLook(page, look);
        await settle(page);
        const glass = await read();
        report(
          compareInventories(classic!, glass ?? [], ALLOWLIST, {
            path: '/dashboard',
            width: width(page),
          }),
          `${overlay.name} (${process.env.STAGE5_ROLE}, ${look.design} ${look.theme})`,
        );
      }
      await chooseLook(page, START);
    });
  }
});

test.describe('signed out: the site and the auth pages', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    test.skip(stage5Role() !== null, 'Runs in the signed-out run.');
  });

  for (const path of [...MARKETING_PATHS, '/signin', '/signup', '/reset']) {
    test(`${path}: the same actions in Classic and in Liquid Glass`, async ({
      page,
      baseURL,
      request,
    }) => {
      const rollout = await buildRollout(request);
      test.skip(rollout === 'off', 'off: Liquid Glass is not offered.');
      await arriveWith(page.context(), baseURL!, 'classic');
      await skipLandingIntro(page);
      await page.goto(path);
      await settle(page);
      const marketing = (MARKETING_PATHS as readonly string[]).includes(path);
      await comparePage(page, async (look) => {
        await chooseSiteLook(page, look);
        if (marketing) await waitForTwin(page, look.design);
      });
    });
  }
});

test.describe('the customer portal', () => {
  test.beforeEach(() => {
    test.skip(stage5Role() !== 'portal', 'Runs in the portal principal’s run.');
  });

  test('/portal and the first item it links to: the same actions in Classic and in Liquid Glass', async ({
    page,
    context,
  }) => {
    const response = await page.goto('/portal');
    if (!response || response.status() >= 400)
      test.skip(true, '/portal is not open to this principal.');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
    // The portal's look is chosen in a second tab of the portal (its corner menu).
    const remote = await context.newPage();
    await remote.goto('/portal');
    const choose = async (look: Look) => {
      await chooseSiteLook(remote, look);
      await page.waitForFunction(
        ({ glass, dark }) =>
          (document.documentElement.getAttribute('data-appearance') === 'liquid-glass') === glass &&
          document.documentElement.classList.contains('dark') === dark,
        { glass: look.design === 'liquid-glass', dark: look.theme === 'dark' },
      );
    };
    await comparePage(page, choose);
    const item = page.locator('main a[href^="/p/items/"]').first();
    if (await item.isVisible().catch(() => false)) {
      await page.goto((await item.getAttribute('href'))!);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await comparePage(page, choose);
    }
    await remote.close();
  });
});
