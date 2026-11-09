import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  SEQUENCE,
  settle,
  settleIntroNotice,
  START,
  toastTexts,
  watchDataRequests,
  watchRealtimeJoins,
} from './look';
import { openFirstOrder } from './orders-look';
import { bellCount } from './stage5a-lib';

/**
 * PROVES plan 8.2 case 2 (the part no earlier spec covers: an unsaved new
 * purchase order) and the sixth assertion of every case, A6 "no duplicate
 * toasts or notifications", for notifications (look.ts covered toasts only):
 *
 *  - /dashboard/purchase-orders/new with an unsaved PO number, expected
 *    delivery date and notes (and every other field as it was) keeps each
 *    value through Dark, Liquid Glass Night and Day, Light and Dark, with
 *    the URL and the scroll (within 4 px), no data request (switch-
 *    requests.ts rules), no new realtime join, no toast twice;
 *  - on Items, an order's page and Place an order, the bell's unread count
 *    is the same after every switch as before the first, no toast appears
 *    twice and none appears that was not there (a switch must not replay
 *    notifications: the bell pops a toast per new notification).
 *
 * Lab command (after run-stage5.sh has built and started the branch, in any
 * rollout; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/transitions-forms.spec.ts
 * Signed in as the run's role (storageState .auth/stage5-<role>.json); a
 * route this role cannot open, or with no record, skips with its reason.
 */

async function ready(page: Page): Promise<void> {
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, START);
}

/** Every field's value in the page's main form, in document order. */
async function formValues(page: Page): Promise<string[]> {
  return page
    .locator('main')
    .locator('input:not([type="hidden"]), textarea, select')
    .evaluateAll((fields) =>
      fields.map((f) => {
        const field = f as HTMLInputElement;
        const value =
          field.type === 'checkbox' || field.type === 'radio' ? String(field.checked) : field.value;
        return `${field.getAttribute('name') ?? field.id ?? field.tagName}: ${value}`;
      }),
    );
}

test('New purchase order: unsaved values survive every switch, with no data request, no new realtime join and no repeated toast', async ({
  page,
}) => {
  const joins = watchRealtimeJoins(page);
  const response = await page.goto('/dashboard/purchase-orders/new');
  if (!response || response.status() >= 400 || !/\/purchase-orders\/new/u.test(page.url()))
    test.skip(true, 'This user cannot create purchase orders.');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await ready(page);

  const number = page.getByLabel(/^PO number/u);
  const expected = page.getByLabel(/^Expected delivery/u);
  const notes = page.getByLabel(/^Notes/u);
  await number.fill('PO-LAB-DRAFT-7');
  await expected.fill('2031-04-15');
  await notes.fill('Unsaved lab draft: deliver to the side door.');
  await page.locator('main#main-content').evaluate((main) => {
    main.scrollTop = Math.min(160, main.scrollHeight - main.clientHeight);
  });
  await settle(page);

  const url = page.url();
  const values = await formValues(page);
  expect(values.join('\n')).toContain('PO-LAB-DRAFT-7');
  const scrollTop = await page.locator('main#main-content').evaluate((main) => main.scrollTop);
  const toastsBefore = await toastTexts(page);
  const joinsBefore = joins.count();
  const requests = await watchDataRequests(page);

  for (const look of SEQUENCE) {
    await chooseLook(page, look);
    await settle(page);
    const where = `after ${look.design} ${look.theme}`;
    expect(page.url(), where).toBe(url);
    expect(await formValues(page), `form values ${where}`).toEqual(values);
    await expect(number).toHaveValue('PO-LAB-DRAFT-7');
    await expect(expected).toHaveValue('2031-04-15');
    await expect(notes).toHaveValue('Unsaved lab draft: deliver to the side door.');
    expect(
      Math.abs(
        (await page.locator('main#main-content').evaluate((main) => main.scrollTop)) - scrollTop,
      ),
      `scroll ${where}`,
    ).toBeLessThanOrEqual(4);
    expect(requests.list(), `data requests ${where}`).toEqual([]);
    expect(joins.count(), `realtime joins ${where}`).toBe(joinsBefore);
    const toasts = await toastTexts(page);
    expect(new Set(toasts).size, `no toast twice ${where}`).toBe(toasts.length);
    expect(
      toasts.filter((t) => !toastsBefore.includes(t)),
      `no new toast ${where}`,
    ).toEqual([]);
  }
});

/** Opens the route; false when this user has nothing to show there. */
type Opener = (page: Page) => Promise<boolean>;

const BELL_ROUTES: Array<{ name: string; open: Opener }> = [
  {
    name: 'Items',
    open: async (page) => {
      await page.goto('/dashboard/inventory');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      return true;
    },
  },
  {
    name: 'An order page',
    open: async (page) => openFirstOrder(page, 'all_active'),
  },
  {
    name: 'Place an order',
    open: async (page) => {
      await page.goto('/dashboard/orders/new');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      return page
        .locator('.sp-storefront')
        .isVisible()
        .catch(() => false);
    },
  },
];

for (const { name, open } of BELL_ROUTES) {
  test(`${name}: the bell's unread count stays and no notification or toast repeats through every switch`, async ({
    page,
  }) => {
    if (!(await open(page))) test.skip(true, `${name}: nothing to show for this user.`);
    await ready(page);
    await settle(page);
    const count = await bellCount(page);
    if (count === null) test.skip(true, 'No bell on this page for this user.');
    const toastsBefore = await toastTexts(page);
    for (const look of SEQUENCE) {
      await chooseLook(page, look);
      await settle(page);
      const where = `after ${look.design} ${look.theme}`;
      expect(await bellCount(page), `bell unread count ${where}`).toBe(count);
      const toasts = await toastTexts(page);
      expect(new Set(toasts).size, `no toast twice ${where}`).toBe(toasts.length);
      expect(
        toasts.filter((t) => !toastsBefore.includes(t)),
        `no new toast ${where}`,
      ).toEqual([]);
    }
  });
}
