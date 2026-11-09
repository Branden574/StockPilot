import { expect, test, type Page } from '@playwright/test';

import { chooseLook, glassBuild, settle, settleIntroNotice, START, waitForLook } from './look';
import { openFirstOrder } from './orders-look';
import { arriveWith, buildRollout, cookieFor, skipLandingIntro, twinOnScreen } from './site-look';
import {
  attributeHistory,
  labUser,
  onlyOnceAcrossRoles,
  recordAttributeHistory,
  signedOutContext,
  signIn,
  submitSignIn,
  watchSaves,
} from './stage5a-lib';

/**
 * PROVES plan 8.2 case 4 on the web, the parts no earlier spec covers (the
 * support draft and landing -> /signin are in site-transitions.spec.ts;
 * relaunch is native, verify/stage5/native):
 *
 *  - RELOAD on Items, an order's page and Place an order (with a cart line):
 *    a reload in Liquid Glass Day keeps the look from the first frame (the
 *    head script sets the attribute before any paint and nothing removes it:
 *    the attribute's whole history never goes back to classic), keeps the
 *    URL, and restores exactly what a reload restores in Classic Dark (the
 *    URL, the page's field values and the cart totals): glass adds no state
 *    of its own and loses none.
 *  - PUBLIC TO AUTHENTICATED in glass: the glass landing, Sign in, the glass
 *    /signin, signing in as lab user A, and Overview in glass, with no frame
 *    of the classic design anywhere on the way (attribute history per
 *    document), A's account already holding Liquid Glass (set first, in a
 *    separate context, through the header menu).
 *
 * Lab command (any rollout; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     STAGE5_A_EMAIL=... STAGE5_A_PASSWORD=... \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/transitions-reload.spec.ts
 * The reload tests run signed in as the run's role; the sign-in test runs
 * once per build (admin run) as lab user A.
 */

const DAY_GLASS = { design: 'liquid-glass', theme: 'light' } as const;

interface Restored {
  url: string;
  fields: string[];
  cart: string[];
}

async function restored(page: Page): Promise<Restored> {
  return {
    url: page.url(),
    fields: await page
      .locator('main')
      .locator('input:not([type="hidden"]), textarea, select')
      .evaluateAll((fields) =>
        fields.map((f) => {
          const field = f as HTMLInputElement;
          return field.type === 'checkbox' || field.type === 'radio'
            ? String(field.checked)
            : field.value;
        }),
      ),
    cart: await page.locator('.sf-cart-foot .sf-tot .v').allInnerTexts(),
  };
}

/** The attribute never returned to classic after it first showed glass. */
function neverClassicAfterGlass(history: (string | null)[]): boolean {
  const first = history.indexOf('liquid-glass');
  return first >= 0 && history.slice(first).every((value) => value === 'liquid-glass');
}

const ROUTES: Array<{
  name: string;
  open(page: Page): Promise<boolean>;
  prepare?(page: Page): Promise<boolean>;
}> = [
  {
    name: 'Items',
    open: async (page) => {
      await page.goto('/dashboard/inventory');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      return true;
    },
  },
  { name: 'An order page', open: async (page) => openFirstOrder(page, 'all_active') },
  {
    name: 'Place an order',
    open: async (page) => {
      await page.goto('/dashboard/orders/new');
      return page
        .locator('.sp-storefront')
        .isVisible()
        .catch(() => false);
    },
    prepare: async (page) => {
      const add = page.getByRole('button', { name: /Add to cart/u });
      if ((await add.count()) < 1) return false;
      await add.first().click();
      await settle(page);
      return true;
    },
  },
];

for (const route of ROUTES) {
  test(`${route.name}: a reload in Liquid Glass Day keeps the look from the first frame and restores what Classic restores`, async ({
    page,
  }) => {
    await recordAttributeHistory(page);
    if (!(await route.open(page))) test.skip(true, `${route.name}: nothing to show for this user.`);
    if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
    await settleIntroNotice(page);
    await chooseLook(page, START);
    if (route.prepare && !(await route.prepare(page)))
      test.skip(true, `${route.name}: nothing to prepare for this user.`);
    await settle(page);

    await page.reload();
    await waitForLook(page, START);
    await settle(page);
    const inClassic = await restored(page);

    await chooseLook(page, DAY_GLASS);
    await settle(page);
    await page.reload();
    await waitForLook(page, DAY_GLASS);
    await settle(page);
    expect(
      neverClassicAfterGlass(await attributeHistory(page)),
      `${route.name}: no classic frame after the reload (${(await attributeHistory(page)).join(' > ')})`,
    ).toBe(true);
    const inGlass = await restored(page);
    expect(inGlass, `${route.name}: what a reload restores, glass vs classic`).toEqual(inClassic);

    await chooseLook(page, START);
  });
}

test('Public to authenticated in glass: the landing, Sign in, /signin, sign-in and Overview, with no classic frame on the way', async ({
  browser,
  baseURL,
  request,
}) => {
  onlyOnceAcrossRoles();
  const rollout = await buildRollout(request);
  test.skip(rollout === 'off', 'off: Liquid Glass is not offered.');
  const user = labUser('A');

  // A's account holds Day glass, chosen through the header menu, so the row
  // read at sign-in agrees with the signed-out choice whatever it held.
  const setup = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const setupPage = await setup.newPage();
  const setupSaves = watchSaves(setupPage);
  await signIn(setupPage, user);
  await settleIntroNotice(setupPage);
  await chooseLook(setupPage, { design: 'classic', theme: 'light' });
  await chooseLook(setupPage, DAY_GLASS);
  await expect
    .poll(() => setupSaves.list().some((s) => s.style === 'liquid-glass'), {
      message: 'the account save of Liquid Glass',
    })
    .toBe(true);
  await settle(setupPage);
  await setup.close();

  const context = await signedOutContext(browser, baseURL!);
  await recordAttributeHistory(context);
  await arriveWith(context, baseURL!, cookieFor(rollout, 'liquid-glass'));
  await context.addInitScript(() => {
    try {
      localStorage.setItem('theme', 'light');
    } catch {
      /* storage blocked: the theme then follows the system, which the check below names */
    }
  });
  const page = await context.newPage();
  await skipLandingIntro(page);
  await page.goto('/');
  expect(await twinOnScreen(page), 'the glass landing').toBe(true);
  expect(neverClassicAfterGlass(await attributeHistory(page)), 'landing: no classic frame').toBe(
    true,
  );
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Sign in', exact: true })
    .click();
  await page.waitForURL('**/signin');
  await waitForLook(page, DAY_GLASS);
  expect(neverClassicAfterGlass(await attributeHistory(page)), '/signin: no classic frame').toBe(
    true,
  );

  await submitSignIn(page, user);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await waitForLook(page, DAY_GLASS);
  await settle(page);
  const history = await attributeHistory(page);
  expect(
    neverClassicAfterGlass(history),
    `Overview: no classic frame (${history.join(' > ')})`,
  ).toBe(true);
  expect(new URL(page.url()).pathname).toBe('/dashboard');
  await context.close();
});
