import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  settle,
  settleIntroNotice,
  START,
  waitForLook,
  type Look,
} from './look';
import { deviceSnapshot } from './stage5a-lib';
import { canonicalJson } from './stage5a-records';

/**
 * PROVES plan 8.2 case 10 on the web (plan 5.6, R13; the phone half is
 * native): a render error thrown in the browser while glass shows, forced
 * WITHOUT any change to app source, reaches an error boundary that offers
 * "Use classic design"; then
 *  - the next load in that tab is classic, once with the notice ("Liquid
 *    Glass hit a problem, so StockPilot opened in the classic look."), the
 *    load after it is classic with no second notice, a new tab is glass
 *    again, and the stored choice (device record, Design cookie) never
 *    changed;
 *  - "Use classic design" on the error screen sets the Design to Classic for
 *    good: the reload, a new tab and the stored records are all classic.
 *
 * HOW THE ERROR IS FORCED: a probe page learns which script chunks only the
 * target route loads on a client navigation (from Items to an item's page,
 * from Reports to Book Order Totals, from Orders to an order); the test page
 * then aborts exactly those chunk URLs (page.route) and makes the same
 * client navigation in glass, so the route's lazy client component fails to
 * load in the browser (a ChunkLoadError, no server digest), which the
 * dashboard error boundary catches. If no candidate route has a chunk of its
 * own, or the boundary never shows (Next falling back to a hard navigation,
 * say), the test FAILS with "GAP C10" and what it saw: that is a stage 5
 * finding (no source-free way to force the error), to be recorded, never a
 * pass.
 *
 * Lab command (opt-in or default; skips in `off`):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port> STAGE5_ROLE=admin \
 *     pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/recovery.spec.ts
 * Signed in as the run's role (organisation members only); ends in Classic Dark.
 */

const NIGHT: Look = { design: 'liquid-glass', theme: 'dark' };
const NOTICE = 'Liquid Glass hit a problem, so StockPilot opened in the classic look.';

test.beforeEach(() => {
  test.skip(
    ['platform', 'portal', 'anonymous', undefined].includes(process.env.STAGE5_ROLE),
    'Needs an organisation member’s run.',
  );
});

interface Target {
  name: string;
  from: string;
  link: string;
}

const TARGETS: Target[] = [
  {
    name: 'an item’s page',
    from: '/dashboard/inventory',
    link: 'table tbody tr a[href^="/dashboard/inventory/"]',
  },
  {
    name: 'Book Order Totals',
    from: '/dashboard/reports',
    link: 'main a[href="/dashboard/reports/book-order-totals"]',
  },
  {
    name: 'an order',
    from: '/dashboard/orders?status=all_active',
    link: 'table tbody tr td:first-child a',
  },
];

/** What this device stores as the person's choice: the Design cookie, the device record, next-themes' theme. */
async function storedChoice(page: Page): Promise<string> {
  const s = await deviceSnapshot(page);
  return canonicalJson({
    cookie: s.cookie,
    design: s.local['sp-appearance'],
    theme: s.local.theme,
  });
}

const scriptUrl = (url: string) => /\/_next\/static\/chunks\/.+\.js(\?|$)/u.test(url);

/** The chunks a client navigation to the target loads that its starting page did not. */
async function targetChunks(page: Page, target: Target): Promise<string[]> {
  const loaded = new Set<string>();
  const listener = (request: { url(): string }) => {
    if (scriptUrl(request.url())) loaded.add(request.url());
  };
  page.on('request', listener);
  await page.goto(target.from);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(page);
  const before = new Set(loaded);
  const link = page.locator(target.link).first();
  if (!(await link.isVisible().catch(() => false))) {
    page.off('request', listener);
    return [];
  }
  await link.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  page.off('request', listener);
  return [...loaded].filter((url) => !before.has(url));
}

/**
 * Opens a fresh tab in glass Night on the target's starting page, with the
 * target's own chunks blocked, and makes the client navigation. Returns the
 * page showing the error boundary, or throws GAP C10.
 */
async function forceGlassRenderError(
  context: BrowserContext,
): Promise<{ page: Page; target: Target }> {
  const probe = await context.newPage();
  let chosen: { target: Target; chunks: string[] } | null = null;
  const seen: string[] = [];
  for (const target of TARGETS) {
    const chunks = await targetChunks(probe, target);
    seen.push(`${target.name}: ${chunks.length} chunk(s) of its own`);
    if (chunks.length > 0) {
      chosen = { target, chunks };
      break;
    }
  }
  await probe.close();
  if (!chosen)
    throw new Error(`GAP C10: no candidate route loads a chunk of its own (${seen.join('; ')}).`);

  const page = await context.newPage();
  const blocked = new Set(chosen.chunks.map((url) => new URL(url).pathname));
  await page.route(
    (url) => blocked.has(url.pathname),
    (route) => route.abort('failed'),
  );
  await page.goto(chosen.target.from);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settleIntroNotice(page);
  await chooseLook(page, NIGHT);
  await settle(page);
  await page.locator(chosen.target.link).first().click();
  const recover = page.getByRole('button', { name: 'Use classic design' });
  const shown = await recover
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    const where = page.url();
    const glass = await page
      .evaluate(() => document.documentElement.getAttribute('data-appearance'))
      .catch(() => 'unknown');
    throw new Error(
      `GAP C10: blocking ${blocked.size} chunk(s) of ${chosen.target.name} and navigating in glass did not reach an error boundary with "Use classic design" (now at ${where}, data-appearance=${glass}). No source-free way to force the render error was found.`,
    );
  }
  await page.unroute((url) => blocked.has(url.pathname));
  return { page, target: chosen.target };
}

test('A forced render error in glass: the next load is classic once with the notice, a new tab is glass, the stored choice never changed', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/whats-new');
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, NIGHT);
  await settle(page);
  const stored = await storedChoice(page);

  const { page: broken } = await forceGlassRenderError(context);
  expect(
    await broken.evaluate(() => sessionStorage.getItem('sp-lg-fallback')),
    'the crash fallback is armed for this tab',
  ).toBe('pending');
  expect(await storedChoice(broken), 'the stored choice is unchanged by the error').toBe(stored);

  await broken.reload();
  await expect(broken.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await waitForLook(broken, { design: 'classic', theme: 'dark' });
  await expect(broken.getByText(NOTICE)).toHaveCount(1);
  await broken.reload();
  await expect(broken.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await settle(broken);
  await waitForLook(broken, { design: 'classic', theme: 'dark' });
  await expect(broken.getByText(NOTICE), 'the notice is shown once').toHaveCount(0);

  const fresh = await context.newPage();
  await fresh.goto('/dashboard/whats-new');
  await waitForLook(fresh, NIGHT);
  expect(await storedChoice(fresh), 'the stored choice is still Liquid Glass Night').toBe(stored);
  expect(await storedChoice(broken), 'and in the tab that crashed').toBe(stored);
  await fresh.close();
  await broken.close();
  await chooseLook(page, START);
});

test('"Use classic design" on the error screen sets Classic for good', async ({
  page,
  context,
}) => {
  await page.goto('/dashboard/whats-new');
  if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
  await settleIntroNotice(page);
  await chooseLook(page, NIGHT);
  await settle(page);

  const { page: broken } = await forceGlassRenderError(context);
  await Promise.all([
    broken.waitForEvent('load'),
    broken.getByRole('button', { name: 'Use classic design' }).click(),
  ]);
  await expect(broken.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await waitForLook(broken, { design: 'classic', theme: 'dark' });
  const records = await deviceSnapshot(broken);
  expect(JSON.parse(records.local['sp-appearance'] ?? 'null')).toMatchObject({ style: 'classic' });
  await expect.poll(async () => (await deviceSnapshot(broken)).cookie).toBe('classic');

  const fresh = await context.newPage();
  await fresh.goto('/dashboard/whats-new');
  await waitForLook(fresh, { design: 'classic', theme: 'dark' });
  await fresh.close();
  await broken.close();
  await chooseLook(page, START);
});
