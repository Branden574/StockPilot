import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  chooseLook,
  glassBuild,
  settleIntroNotice,
  waitForLook,
  watchDataRequests,
  type Look,
} from '../e2e/appearance/look';
import { assertLocal } from '../e2e/appearance/stage5-env';
import {
  EXPECTED_ROUTES,
  type InteractionSample,
  type LoadSample,
  type ScrollSample,
  type SwitchSample,
} from './appearance-compare.mjs';
import {
  armSwitchLatency,
  COLLECTOR_SCRIPT,
  frameSummary,
  interactionToNextPaint,
  readCollected,
  readLoad,
  readSwitchLatency,
  scriptedScroll,
  throttle,
} from './appearance-metrics';

/**
 * PLAN 8.4 AND R12: THE LIQUID GLASS PERFORMANCE RUN, ONE BUILD AT A TIME.
 *
 * The runner (liquid-glass/verify/stage5/run-stage5.sh) serves each build
 * with `next start` on the lab and runs this file once per build, naming it
 * in STAGE5_PERF_BUILD:
 *   B               classic at the merge base (no Design at all);
 *   B-repeat        B again, for the A/A drift;
 *   branch-classic  the branch (opt-in build) in Classic;
 *   branch-glass    the branch (opt-in build) in Liquid Glass.
 * Samples go to STAGE5_PERF_OUT as JSON; perf-compare.mjs judges them
 * (appearance-compare.mjs: medians, both sides sorted, noise, budgets).
 *
 * Per route (Overview, Items table and grid, Books, Item detail, Orders,
 * Place an Order, Order detail, Book Order Totals, the landing), 3 cold runs
 * (a new browser context: empty cache) and 3 warm runs (the same context,
 * loaded again), each a hard load: TTFB, FCP, LCP, the app's usable mark,
 * CLS, JS / CSS / image transfer bytes, the bytes of glass rules in the CSS
 * the page loaded (what a Classic visitor carries for glass), scene photo
 * bytes and count, the JS heap and the live blur count on screen.
 * Then (desktop profile): a scripted 5 s scroll of the main pane at CPU 1x,
 * 4x and 6x on Overview, Items and Place an Order (frame deltas plus long
 * animation frames); INP of row select (Items), open dialog (an item's
 * Adjust stock) and add to cart (Place an Order); the switch latency from
 * the menu keypress to the first frame with the new look, and the data
 * requests a switch made.
 * The R12 low-end profile (CPU 6x, Slow 4G, 390 x 844) repeats the landing
 * cold loads (LCP and CLS budget) and the 6x scroll, once in the normal
 * material and once with data-lg-material="reduced" brought on the way the
 * app sets it (navigator.deviceMemory 2 and hardwareConcurrency 2, R7).
 *
 * Lab command (the runner sets the build's server first):
 *   STAGE5_ROLE=manager STAGE5_PERF_BUILD=branch-glass STAGE5_PERF_OUT=<dir> \
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=perf appearance.perf.ts
 */

type Build = 'B' | 'B-repeat' | 'branch-classic' | 'branch-glass';
const BUILD = (process.env.STAGE5_PERF_BUILD ?? '') as Build;
const OUT = process.env.STAGE5_PERF_OUT ?? '';
const RUNS = Number(process.env.STAGE5_PERF_RUNS ?? 3);
const PROFILES = (process.env.STAGE5_PERF_PROFILES ?? 'desktop,low-end').split(',');

test.skip(
  !['B', 'B-repeat', 'branch-classic', 'branch-glass'].includes(BUILD),
  'STAGE5_PERF_BUILD names no build.',
);
test.skip(OUT === '', 'STAGE5_PERF_OUT is not set.');

interface RouteDef {
  key: string;
  path?: string;
  first?: { list: string; link: string };
  signedOut?: boolean;
  cookies?: Record<string, string>;
}
const ROUTES: RouteDef[] = [
  { key: 'overview', path: '/dashboard' },
  { key: 'items', path: '/dashboard/inventory', cookies: { sp_view_items: 'table' } },
  { key: 'items-grid', path: '/dashboard/inventory', cookies: { sp_view_items: 'grid' } },
  { key: 'books', path: '/dashboard/books' },
  {
    key: 'item-detail',
    first: { list: '/dashboard/inventory', link: 'tbody a[href^="/dashboard/inventory/"]' },
  },
  { key: 'orders', path: '/dashboard/orders' },
  { key: 'place-order', path: '/dashboard/orders/new' },
  {
    key: 'order-detail',
    first: {
      list: '/dashboard/orders',
      link: 'main a[href^="/dashboard/orders/"]:not([href$="/new"]):not([href*="manage-items"])',
    },
  },
  { key: 'book-order-totals', path: '/dashboard/reports/book-order-totals' },
  { key: 'landing', path: '/', signedOut: true },
];
const SCROLL_ROUTES = ['overview', 'items', 'place-order'];
// The judge expects exactly these routes on every build (a missing one fails there): keep the lists equal.
if (ROUTES.map((r) => r.key).join() !== EXPECTED_ROUTES.join())
  throw new Error(
    `appearance.perf.ts ROUTES (${ROUTES.map((r) => r.key).join()}) differ from appearance-compare.mjs EXPECTED_ROUTES (${EXPECTED_ROUTES.join()})`,
  );

const DESIGN: Record<Build, Look['design'] | null> = {
  B: null,
  'B-repeat': null,
  'branch-classic': 'classic',
  'branch-glass': 'liquid-glass',
};
const LOOK: Look | null = DESIGN[BUILD] ? { design: DESIGN[BUILD]!, theme: 'light' } : null;

const samples: {
  loads: LoadSample[];
  scrolls: ScrollSample[];
  interactions: InteractionSample[];
  switches: SwitchSample[];
} = { loads: [], scrolls: [], interactions: [], switches: [] };

/** Writes one kind of sample to its own file (perf-compare.mjs merges the files of a build). */
function save(kind: keyof typeof samples): void {
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(OUT, `${kind}.json`),
    `${JSON.stringify({ [kind]: samples[kind] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** A storage state with the build's look chosen through the real menu (it is then the account's choice too). */
async function lookState(browser: Browser, baseURL: string, storage: string): Promise<string> {
  const context = await browser.newContext({ storageState: storage, baseURL });
  const page = await context.newPage();
  await page.goto('/dashboard/whats-new');
  if (LOOK) {
    if (!(await glassBuild(page)))
      throw new Error(`${BUILD} must be served by a build that offers Liquid Glass`);
    await settleIntroNotice(page);
    await chooseLook(page, LOOK);
  }
  // The state holds the lab session cookies: written only inside a fresh
  // 0700 folder as a 0600 file, and removed when the file's tests end.
  const dir = mkdtempSync(join(tmpdir(), 'stage5-perf-'));
  stateDirs.push(dir);
  const path = join(dir, `${BUILD}.json`);
  writeFileSync(path, JSON.stringify(await context.storageState()), { mode: 0o600 });
  await context.close();
  return path;
}

const stateDirs: string[] = [];
test.afterAll(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function resolvePath(page: Page, route: RouteDef): Promise<string | null> {
  if (route.path) return route.path;
  await page.goto(route.first!.list);
  await page
    .locator('h1')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const href = await page
    .locator(route.first!.link)
    .first()
    .getAttribute('href')
    .catch(() => null);
  return href ? new URL(href, page.url()).pathname : null;
}

async function newContext(
  browser: Browser,
  baseURL: string,
  route: RouteDef,
  state: string,
  profile: string,
): Promise<BrowserContext> {
  const lowEnd = profile === 'low-end';
  const context = await browser.newContext({
    baseURL,
    storageState: route.signedOut ? { cookies: [], origins: [] } : state,
    viewport: lowEnd ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: lowEnd ? 3 : 2,
  });
  await context.addInitScript(COLLECTOR_SCRIPT);
  const cookies = { ...(route.cookies ?? {}) };
  // Signed out, the look is the cookie alone (no account row).
  if (route.signedOut && LOOK) cookies.sp_style = LOOK.design;
  const list = Object.entries(cookies).map(([name, value]) => ({ name, value, url: baseURL }));
  if (list.length) await context.addCookies(list);
  return context;
}

/** One hard load: navigate, wait until drawn and quiet, read the metrics. */
async function load(page: Page, path: string, cdp: Awaited<ReturnType<typeof throttle>>) {
  await page.goto(path, { waitUntil: 'load' });
  await page
    .locator('h1, main')
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // LCP is final once the page has been quiet; a short wait lets the last candidate land.
  await page.waitForTimeout(1500);
  if (LOOK) await waitForLook(page, LOOK).catch(() => undefined);
  return readLoad(page, cdp);
}

test('page loads, cold and warm, per route and profile', async ({ browser, baseURL }) => {
  assertLocal({ PLAYWRIGHT_BASE_URL: baseURL });
  const storage = test.info().project.use.storageState;
  expect(typeof storage, 'a signed-in storageState (setup project)').toBe('string');
  const state = await lookState(browser, baseURL!, storage as string);
  for (const profile of PROFILES) {
    const routes = profile === 'low-end' ? ROUTES.filter((r) => r.key === 'landing') : ROUTES;
    for (const route of routes) {
      for (let run = 1; run <= RUNS; run += 1) {
        const context = await newContext(browser, baseURL!, route, state, profile);
        const page = await context.newPage();
        const cdp = await throttle(context, page, {
          cpu: profile === 'low-end' ? 6 : 1,
          slowNetwork: profile === 'low-end',
        });
        try {
          const path = await resolvePath(page, route);
          if (!path) {
            test
              .info()
              .annotations.push({ type: 'skipped-route', description: `${route.key}: no record` });
            break;
          }
          // A detail route resolved above warmed the cache: start that cold run from a fresh context.
          let target = page;
          let targetCdp = cdp;
          let ctx = context;
          if (route.first) {
            await context.close();
            ctx = await newContext(browser, baseURL!, route, state, profile);
            target = await ctx.newPage();
            targetCdp = await throttle(ctx, target, {
              cpu: profile === 'low-end' ? 6 : 1,
              slowNetwork: profile === 'low-end',
            });
          }
          const cold = await load(target, path, targetCdp);
          samples.loads.push({
            build: BUILD,
            profile,
            route: route.key,
            mode: 'cold',
            run,
            metrics: { ...cold },
          });
          const warm = await load(target, path, targetCdp);
          samples.loads.push({
            build: BUILD,
            profile,
            route: route.key,
            mode: 'warm',
            run,
            metrics: { ...warm },
          });
          if (ctx !== context) await ctx.close();
        } finally {
          await context.close().catch(() => undefined);
        }
      }
      save('loads');
    }
  }
});

test('scripted 5 s scroll at CPU 1x, 4x and 6x (and the reduced material at 6x)', async ({
  browser,
  baseURL,
}) => {
  const state = await lookState(browser, baseURL!, test.info().project.use.storageState as string);
  const plan: { profile: string; cpu: number; material: 'normal' | 'reduced' }[] = [
    { profile: 'desktop', cpu: 1, material: 'normal' },
    { profile: 'desktop', cpu: 4, material: 'normal' },
    { profile: 'desktop', cpu: 6, material: 'normal' },
  ];
  if (PROFILES.includes('low-end'))
    plan.push(
      { profile: 'low-end', cpu: 6, material: 'normal' },
      { profile: 'low-end', cpu: 6, material: 'reduced' },
    );
  for (const step of plan) {
    if (step.material === 'reduced' && BUILD !== 'branch-glass') continue;
    for (const key of SCROLL_ROUTES) {
      const route = ROUTES.find((r) => r.key === key)!;
      for (let run = 1; run <= RUNS; run += 1) {
        const context = await newContext(browser, baseURL!, route, state, step.profile);
        if (step.material === 'reduced')
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
          });
        const page = await context.newPage();
        try {
          await page.goto(route.path!);
          await page
            .locator('h1')
            .first()
            .waitFor({ timeout: 30_000 })
            .catch(() => undefined);
          await page.waitForLoadState('networkidle').catch(() => undefined);
          if (step.material === 'reduced')
            await expect(page.locator('html')).toHaveAttribute('data-lg-material', 'reduced');
          await throttle(context, page, { cpu: step.cpu, slowNetwork: step.profile === 'low-end' });
          const scroll = await scriptedScroll(page, 'main#main-content');
          const { loaf } = await readCollected(page);
          const f = frameSummary(scroll.deltas, loaf, scroll);
          samples.scrolls.push({
            build: BUILD,
            profile: step.profile,
            route: key,
            cpu: step.cpu,
            material: step.material,
            run,
            ...f,
            scrollMax: scroll.max,
          });
        } finally {
          await context.close();
        }
      }
    }
    save('scrolls');
  }
});

test('INP: row select, open dialog, add to cart', async ({ browser, baseURL }) => {
  const state = await lookState(browser, baseURL!, test.info().project.use.storageState as string);
  const interactions: {
    name: string;
    path: string | { list: string; link: string };
    act: (p: Page) => Promise<void>;
  }[] = [
    {
      name: 'row-select',
      path: '/dashboard/inventory',
      act: (p) =>
        p
          .getByRole('table')
          .getByRole('checkbox', { name: /^Select (?!all)/u })
          .first()
          .click(),
    },
    {
      name: 'open-dialog',
      path: { list: '/dashboard/inventory', link: 'tbody a[href^="/dashboard/inventory/"]' },
      act: async (p) => {
        await p
          .getByRole('button', { name: /adjust stock/iu })
          .first()
          .click();
        await expect(p.getByRole('dialog')).toBeVisible();
      },
    },
    {
      name: 'add-to-cart',
      path: '/dashboard/orders/new',
      act: (p) => p.getByRole('button', { name: /^add/iu }).first().click(),
    },
  ];
  for (const it of interactions) {
    for (let run = 1; run <= RUNS; run += 1) {
      const route: RouteDef =
        typeof it.path === 'string'
          ? { key: it.name, path: it.path }
          : { key: it.name, first: it.path };
      const context = await newContext(browser, baseURL!, route, state, 'desktop');
      const page = await context.newPage();
      try {
        const path = await resolvePath(page, route);
        if (!path) break;
        await page.goto(path);
        await page
          .locator('h1')
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => undefined);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const since = await page.evaluate(() => performance.now());
        await it.act(page);
        await page.waitForTimeout(500);
        const { events } = await readCollected(page);
        samples.interactions.push({
          build: BUILD,
          profile: 'desktop',
          interaction: it.name,
          run,
          inpMs: interactionToNextPaint(events, since),
        });
      } finally {
        await context.close();
      }
    }
  }
  save('interactions');
});

test('switch latency and no refetch (glass builds)', async ({ browser, baseURL }) => {
  test.skip(BUILD !== 'branch-glass', 'Only a build offering Liquid Glass switches.');
  const state = await lookState(browser, baseURL!, test.info().project.use.storageState as string);
  for (const key of SCROLL_ROUTES) {
    const route = ROUTES.find((r) => r.key === key)!;
    const context = await newContext(browser, baseURL!, route, state, 'desktop');
    const page = await context.newPage();
    try {
      await page.goto(route.path!);
      await page.locator('h1').first().waitFor({ timeout: 30_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const sequence: Look[] = [
        { design: 'liquid-glass', theme: 'dark' },
        { design: 'classic', theme: 'dark' },
        { design: 'classic', theme: 'light' },
        { design: 'liquid-glass', theme: 'light' },
      ];
      let run = 0;
      for (const look of sequence) {
        run += 1;
        const requests = await watchDataRequests(page);
        await armSwitchLatency(page);
        await chooseLook(page, look);
        await page.waitForTimeout(800);
        samples.switches.push({
          build: BUILD,
          profile: 'desktop',
          route: key,
          run,
          latencyMs: await readSwitchLatency(page),
          dataRequests: requests.list().length,
        });
      }
    } finally {
      await context.close();
    }
  }
  save('switches');
});
