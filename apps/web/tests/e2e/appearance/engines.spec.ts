import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  SEQUENCE,
  settle,
  settleIntroNotice,
  START,
  waitForLook,
  watchDataRequests,
} from './look';
import {
  arriveWith,
  buildRollout,
  chooseLook as chooseSiteLook,
  SEQUENCE as SITE_SEQUENCE,
  skipLandingIntro,
  twinOnScreen,
  waitForTwin,
} from './site-look';
import { deviceSnapshot, isChromium, throttleCpu } from './stage5a-lib';
import { comparedPart } from './stage5a-records';

/**
 * PROVES plan 8.2 case 7 on the web (iOS 18/26, the native Reduce
 * Transparency and offline screens are native, verify/stage5/native):
 *
 *  - OLDER ENGINES: the switch sequence (Dark, Liquid Glass Night and Day,
 *    Light, Dark) on Items (ticked rows, scroll, no data request), Place an
 *    order (the cart's totals, no data request) and the landing (the twin
 *    of each Design, same URL) in every project the stage 5 config defines:
 *    Chrome, and WebKit and Firefox when a matching browser is installed
 *    (playwright.stage5.config.ts gates them);
 *  - CPU 4x and 6x (Chromium, CDP): the same Items sequence, each switch
 *    shown within 5 s, with the state kept and no data request;
 *  - REDUCED TRANSPARENCY AND REDUCED MOTION AT RUNTIME: toggled on and off
 *    while Items shows glass (prefers-reduced-transparency through CDP in
 *    Chromium only: Safari and Firefox do not support it, plan 8.3; reduced
 *    motion in every engine): the ticked rows, the scroll, the same DOM nodes
 *    and the look stay, and the stored appearance does not change.
 *
 * Lab command (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/engines.spec.ts
 * (every browser project of the config: --project names as the config sets them)
 */

const ROWS = (page: Page) =>
  page.getByRole('table').getByRole('checkbox', { name: /^Select (?!all)/u });

interface ItemsState {
  url: string;
  ticked: string[];
  scrollTop: number;
}

async function itemsState(page: Page): Promise<ItemsState> {
  return {
    url: page.url(),
    ticked: await page
      .getByRole('table')
      .getByRole('checkbox', { checked: true })
      .evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-label') ?? '')),
    scrollTop: await page.locator('main#main-content').evaluate((main) => main.scrollTop),
  };
}

/** Items in Classic Dark with two ticked rows and a scrolled pane; false when there are too few items. */
async function itemsReady(page: Page): Promise<boolean> {
  await page.goto('/dashboard/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
  if ((await ROWS(page).count()) < 2) return false;
  await ROWS(page).nth(0).click();
  await ROWS(page).nth(1).click();
  await page.locator('main#main-content').evaluate((main) => {
    main.scrollTop = Math.min(240, main.scrollHeight - main.clientHeight);
  });
  await settle(page);
  return true;
}

function expectSameItems(after: ItemsState, before: ItemsState, where: string): void {
  expect(after.url, `URL ${where}`).toBe(before.url);
  expect(after.ticked, `ticked rows ${where}`).toEqual(before.ticked);
  expect(Math.abs(after.scrollTop - before.scrollTop), `scroll ${where}`).toBeLessThanOrEqual(4);
}

test.describe('signed in', () => {
  test.beforeEach(() => {
    test.skip(
      !process.env.STAGE5_ROLE || process.env.STAGE5_ROLE === 'anonymous',
      'Needs a signed-in role.',
    );
  });

  test('Items: the switch sequence keeps the ticked rows and the scroll, with no data request, in this browser', async ({
    page,
  }) => {
    if (!(await itemsReady(page))) test.skip(true, 'Needs at least two items.');
    const before = await itemsState(page);
    const requests = await watchDataRequests(page);
    for (const look of SEQUENCE) {
      await chooseLook(page, look);
      await settle(page);
      const where = `after ${look.design} ${look.theme}`;
      expectSameItems(await itemsState(page), before, where);
      expect(requests.list(), `data requests ${where}`).toEqual([]);
    }
  });

  test('Place an order: the switch sequence keeps the cart, with no data request, in this browser', async ({
    page,
  }) => {
    await page.goto('/dashboard/orders/new');
    if (
      !(await page
        .locator('.sp-storefront')
        .isVisible()
        .catch(() => false))
    )
      test.skip(true, 'No warehouse to order from.');
    if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
    await settleIntroNotice(page);
    await chooseLook(page, START);
    const add = page.getByRole('button', { name: /Add to cart/u });
    if ((await add.count()) < 1) test.skip(true, 'Nothing orderable.');
    await add.first().click();
    await settle(page);
    const totals = page.locator('.sf-cart-foot .sf-tot .v');
    const cart = await totals.allInnerTexts();
    const url = page.url();
    const requests = await watchDataRequests(page);
    for (const look of SEQUENCE) {
      await chooseLook(page, look);
      await settle(page);
      const where = `after ${look.design} ${look.theme}`;
      expect(await totals.allInnerTexts(), `cart ${where}`).toEqual(cart);
      expect(page.url(), where).toBe(url);
      expect(requests.list(), `data requests ${where}`).toEqual([]);
    }
  });

  for (const rate of [4, 6]) {
    test(`Items at CPU ${rate}x (Chromium): every switch shows within 5 s and keeps the state, with no data request`, async ({
      page,
    }) => {
      test.skip(!isChromium(page), 'CPU throttling is a Chromium (CDP) feature.');
      if (!(await itemsReady(page))) test.skip(true, 'Needs at least two items.');
      await throttleCpu(page, rate);
      const before = await itemsState(page);
      const requests = await watchDataRequests(page);
      for (const look of SEQUENCE) {
        const started = Date.now();
        await chooseLook(page, look);
        const took = Date.now() - started;
        test.info().annotations.push({
          type: `switch at ${rate}x`,
          description: `${look.design} ${look.theme}: ${took} ms (menu open to look shown)`,
        });
        expect(took, `${look.design} ${look.theme} at ${rate}x`).toBeLessThan(5000);
        await settle(page);
        const where = `after ${look.design} ${look.theme} at ${rate}x`;
        expectSameItems(await itemsState(page), before, where);
        expect(requests.list(), `data requests ${where}`).toEqual([]);
      }
      await throttleCpu(page, 1);
    });
  }

  test('Items in glass: reduced transparency (Chromium) and reduced motion toggled at runtime keep the state, the nodes, the look and the stored appearance', async ({
    page,
  }) => {
    if (!(await itemsReady(page))) test.skip(true, 'Needs at least two items.');
    const night = { design: 'liquid-glass', theme: 'dark' } as const;
    await chooseLook(page, night);
    await settle(page);
    const before = await itemsState(page);
    const stored = comparedPart(await deviceSnapshot(page));
    await page.evaluate(() => {
      for (const node of [
        document.querySelector('main#main-content'),
        document.querySelector('table'),
      ]) {
        if (node) (node as unknown as Record<string, boolean>).__lgEngineProbe = true;
      }
    });
    const requests = await watchDataRequests(page);
    const cdp = isChromium(page) ? await page.context().newCDPSession(page) : null;

    const steps: Array<{ name: string; apply(): Promise<void> }> = [
      { name: 'reduced motion on', apply: () => page.emulateMedia({ reducedMotion: 'reduce' }) },
      {
        name: 'reduced motion off',
        apply: () => page.emulateMedia({ reducedMotion: 'no-preference' }),
      },
    ];
    if (cdp) {
      steps.push(
        {
          name: 'reduced transparency on',
          apply: async () => {
            await cdp.send('Emulation.setEmulatedMedia', {
              features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
            });
          },
        },
        {
          name: 'reduced transparency off',
          apply: async () => {
            await cdp.send('Emulation.setEmulatedMedia', {
              features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
            });
          },
        },
      );
    }
    for (const step of steps) {
      await step.apply();
      await settle(page);
      expectSameItems(await itemsState(page), before, `after ${step.name}`);
      await waitForLook(page, night);
      expect(
        await page.evaluate(() =>
          [document.querySelector('main#main-content'), document.querySelector('table')].every(
            (node) => (node as unknown as Record<string, boolean> | null)?.__lgEngineProbe === true,
          ),
        ),
        `the same nodes after ${step.name}`,
      ).toBe(true);
      expect(comparedPart(await deviceSnapshot(page)), `stored appearance after ${step.name}`).toBe(
        stored,
      );
      expect(requests.list(), `data requests after ${step.name}`).toEqual([]);
    }
    await chooseLook(page, START);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('The landing: the switch sequence shows each Design’s twin at the same URL, in this browser', async ({
    page,
    baseURL,
    request,
  }) => {
    test.skip(
      Boolean(process.env.STAGE5_ROLE) && process.env.STAGE5_ROLE !== 'anonymous',
      'Runs in the signed-out run.',
    );
    const rollout = await buildRollout(request);
    test.skip(rollout === 'off', 'off: Liquid Glass is not offered.');
    await arriveWith(page.context(), baseURL!, 'classic');
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await skipLandingIntro(page);
    await page.goto('/');
    await waitForTwin(page, 'classic');
    const url = page.url();
    for (const look of SITE_SEQUENCE) {
      await chooseSiteLook(page, look);
      await waitForTwin(page, look.design);
      expect(await twinOnScreen(page), `${look.design} ${look.theme}`).toBe(
        look.design === 'liquid-glass',
      );
      expect(page.url()).toBe(url);
    }
  });
});
