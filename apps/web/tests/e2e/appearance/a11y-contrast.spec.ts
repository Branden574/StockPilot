import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import {
  extremeCrops,
  NON_TEXT_RATIO,
  parseCssColor,
  requiredTextRatio,
  worstContrast,
  type Rgb,
} from './a11y-math';
import { backdropShot, sampleBoxes, textRuns } from './composed-pixels';
import { chooseLook, settle } from './look';
import {
  arriveSignedOut,
  GLASS_LOOKS,
  R11_ROUTES,
  requireGlass,
  SIGNED_IN_ROUTES,
  isSignedOutRoute,
  visit,
  type NamedLook,
} from './stage5-pages';
import { coverageProblems, requiredLooks } from './stage5-visit';

/**
 * PLAN 8.3-3 AND R11: CONTRAST OVER COMPOSED GLASS, A RELEASE BLOCKER.
 *
 * For every glass route, in Day glass and Night glass, in the normal, reduced
 * (data-lg-material="reduced" set on <html>, R7) and contrast
 * (`prefers-contrast: more` emulated) materials, every visible text run in
 * the viewport is checked against the pixels the browser composed behind its
 * box (composed-pixels.ts: the page shot with every glyph transparent):
 *  - body text 4.5:1, large text 3:1 (a11y-math.ts requiredTextRatio), as the
 *    WORST ratio over the sampled pixels;
 *  - glass field edges (--input-line) 3:1 against the pixels just outside
 *    the field;
 *  - R11 worst-case scene positions: the same at scroll 0, half way and the
 *    end of the main pane (a fixed scene moves under the panes), and for
 *    every pane the darkest and lightest 10% crops behind it are reported.
 * Disabled, aria-hidden and inert text is exempt (WCAG 1.4.3 inactive UI and
 * incidental text). A miss is fixed in glass tokens, never in Classic.
 * A look in which no text run was measured FAILS (nothing judged is not a
 * pass), and so does a route where a glass look was not measured at all.
 *
 * Projects: chrome runs every signed-in route plus the R11 set; webkit runs
 * the R11 set (7 marketing pages, /signin, Overview, Items, Place an Order),
 * where `prefers-contrast: more` is also supported (round 2, finding 8).
 *
 * Lab commands:
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome --project=webkit a11y-contrast.spec.ts
 *   (signed-out routes) ... --project=anonymous a11y-contrast.spec.ts
 */

type Material = 'normal' | 'reduced' | 'contrast';
const MATERIALS: readonly Material[] = ['normal', 'reduced', 'contrast'];

async function setMaterial(page: Page, material: Material): Promise<void> {
  await page.emulateMedia({ contrast: material === 'contrast' ? 'more' : 'no-preference' });
  await page.evaluate((reduced) => {
    const html = document.documentElement;
    if (reduced) html.setAttribute('data-lg-material', 'reduced');
    else html.removeAttribute('data-lg-material');
  }, material === 'reduced');
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/** Every contrast miss on the viewport now, and how many text runs were measured. */
async function missesNow(
  context: BrowserContext,
  page: Page,
  where: string,
  within?: string,
): Promise<{ misses: string[]; runs: number }> {
  const runs = await textRuns(page, 400, within);
  if (runs.length === 0) return { misses: [], runs: 0 };
  const png = await backdropShot(page);
  const dpr = await page.evaluate(() => devicePixelRatio);
  const samples = await sampleBoxes(
    context,
    png,
    runs.map((r) => r.box),
    dpr,
  );
  const misses: string[] = [];
  const panes = new Map<string, Rgb[]>();
  runs.forEach((run, i) => {
    const s = samples[i]!;
    if (run.pane) panes.set(run.pane, [...(panes.get(run.pane) ?? []), ...s.inside]);
    if (run.edgeColor) {
      const edge = parseCssColor(run.edgeColor);
      const ratio = edge && edge.a > 0 ? worstContrast(edge, s.around) : null;
      if (ratio !== null && ratio < NON_TEXT_RATIO)
        misses.push(`${where} ${run.id}: field edge ${ratio.toFixed(2)}:1 < ${NON_TEXT_RATIO}:1`);
    }
    const text = parseCssColor(run.color);
    if (!text || text.a === 0) return;
    const ratio = worstContrast(text, s.inside);
    const need = requiredTextRatio(run.fontSizePx, run.fontWeight);
    if (ratio !== null && ratio < need)
      misses.push(
        `${where} ${run.id} (${run.fontSizePx}px/${run.fontWeight}, ${run.pane ?? 'no pane'}): ${ratio.toFixed(2)}:1 < ${need}:1`,
      );
  });
  // R11 crops, reported for review (the per-run worst ratio above already covers them).
  const crops = [...panes].map(([pane, px]) => {
    const { dark, light } = extremeCrops(px);
    return {
      pane,
      pixels: px.length,
      darkest: dark[0] ?? null,
      lightest: light[light.length - 1] ?? null,
    };
  });
  await test
    .info()
    .attach(`crops ${where}`, { body: JSON.stringify(crops), contentType: 'application/json' });
  return { misses, runs: runs.length };
}

/** The pane positions a fixed scene is checked at: top, half way, end. */
async function scrollPositions(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const el =
      (document.querySelector('main#main-content') as HTMLElement | null) ??
      document.scrollingElement!;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    return max < 40 ? [0] : [0, Math.round(max / 2), max];
  });
}
async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    const el =
      (document.querySelector('main#main-content') as HTMLElement | null) ??
      document.scrollingElement!;
    el.scrollTop = top;
  }, y);
  await page.waitForTimeout(150);
}

async function checkRoute(
  context: BrowserContext,
  page: Page,
  route: string,
  look: NamedLook,
): Promise<string[]> {
  const misses: string[] = [];
  for (const material of MATERIALS) {
    await setMaterial(page, material);
    let measured = 0;
    for (const y of await scrollPositions(page)) {
      await scrollTo(page, y);
      const now = await missesNow(context, page, `${route} ${look.label} ${material} @${y}`);
      misses.push(...now.misses);
      measured += now.runs;
    }
    if (measured === 0) misses.push(`${route} ${look.label} ${material}: no text run was measured`);
    await scrollTo(page, 0);
  }
  await setMaterial(page, 'normal');
  return misses;
}

const signedIn = (info: TestInfo) => typeof info.project.use.storageState === 'string';

function routesFor(info: TestInfo): string[] {
  const r11 = R11_ROUTES.filter((r) => !isSignedOutRoute(r));
  if (info.project.name === 'webkit') return [...r11];
  return [...new Set<string>([...r11, ...SIGNED_IN_ROUTES])];
}

test.describe('signed in', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
      'Dashboard routes only.',
    );
    test.skip(!['chrome', 'webkit'].includes(info.project.name), 'Chrome and WebKit only.');
  });
  // The route list depends on the project, so one test per route of the widest list skips the rest.
  for (const route of [
    ...new Set<string>([...R11_ROUTES.filter((r) => !isSignedOutRoute(r)), ...SIGNED_IN_ROUTES]),
  ]) {
    test(`${route}: text and field edges hold AA over composed glass`, async ({
      page,
      context,
    }, info) => {
      test.skip(
        !routesFor(info).includes(route),
        `${route} is not in the R11 set this engine runs.`,
      );
      if (!(await visit(page, route, null)))
        test.skip(true, `${route} does not open for this role.`);
      await requireGlass(page);
      const misses: string[] = [];
      const measured: string[] = [];
      for (const look of GLASS_LOOKS) {
        await chooseLook(page, look);
        await settle(page);
        misses.push(...(await checkRoute(context, page, route, look)));
        measured.push(look.label);
      }
      misses.push(...coverageProblems(route, measured, requiredLooks(true, false)));
      expect(misses).toEqual([]);
    });
  }
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    const info = test.info();
    test.skip(
      !['anonymous', 'webkit'].includes(info.project.name),
      'Signed-out routes run in the anonymous (Chrome) and webkit projects.',
    );
  });
  for (const route of R11_ROUTES.filter(isSignedOutRoute)) {
    test(`${route}: text and field edges hold AA over composed glass`, async ({
      browser,
      baseURL,
    }) => {
      const misses: string[] = [];
      const measured: string[] = [];
      for (const look of GLASS_LOOKS) {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await arriveSignedOut(context, baseURL!, look);
          const page = await context.newPage();
          // A signed-out page opens for everyone: visit() fails the test on any error status.
          if (!(await visit(page, route, null))) continue;
          await requireGlass(page);
          misses.push(...(await checkRoute(context, page, route, look)));
          measured.push(look.label);
        } finally {
          await context.close();
        }
      }
      misses.push(...coverageProblems(route, measured, requiredLooks(true, false)));
      expect(misses).toEqual([]);
    });
  }
});

/**
 * THE PRODUCT-UPDATE CARD OVER A BUSY PAGE (lab finding, 2026-11-11).
 *
 * The card (components/updates/update-card.tsx, [data-update-notice]) floats
 * bottom right over whatever page is open. The route checks above never met
 * it: the lab account has read every release, so no notice was up. In Liquid
 * Glass it was drawn with the 46% content fill and no blur, and the Items
 * rows behind it crossed its own words.
 *
 * Here the release list is pinned to hold one unread release (only the list:
 * the app is not changed), so the What's New notice comes up over the Items
 * list, and in Day and Night glass, in each material:
 *  - every text run INSIDE the card holds AA against the pixels composed
 *    behind it (the page's rows are part of those pixels);
 *  - the card is drawn with the overlay material: a fill of at least 70%
 *    and a backdrop blur in the normal material, an opaque fill and no blur
 *    in the reduced and contrast materials.
 */
const UPDATE_NOTICE = '[data-update-notice]';
const PINNED_UNREAD = {
  id: 'inventory-and-orders-2026-09',
  revision: 1,
  status: 'published',
  title: 'Inventory and orders',
  summary: 'Pinned by the contrast spec.',
  publishedAt: '2026-09-18T00:00:00.000Z',
  entryCount: 1,
  state: { read: false, dismissed: false },
};

/** The card's fill alpha and whether it blurs what is behind it, as computed. */
async function noticeSurface(page: Page): Promise<{ alpha: number; blurred: boolean }> {
  return page.locator(UPDATE_NOTICE).evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = /^rgba?\(([^)]*)\)$/u.exec(cs.backgroundColor);
    const parts = m ? m[1]!.split(/[,/\s]+/u).filter(Boolean) : [];
    const filter =
      cs.backdropFilter ||
      (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ||
      'none';
    return { alpha: parts.length >= 4 ? Number(parts[3]) : 1, blurred: filter !== 'none' };
  });
}

test.describe('signed in: the product-update card over a busy page', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
      'Dashboard routes only.',
    );
    test.skip(!['chrome', 'webkit'].includes(info.project.name), 'Chrome and WebKit only.');
  });

  test('its words hold AA over the Items list and it is overlay glass', async ({
    page,
    context,
  }) => {
    await page.route('**/api/v1/me/releases', (route) =>
      route.fulfill({
        json: {
          releases: [PINNED_UNREAD],
          unreadCount: 1,
          latestUnread: PINNED_UNREAD,
          stateAvailable: true,
        },
      }),
    );
    const route = '/dashboard/inventory';
    if (!(await visit(page, route, null))) test.skip(true, `${route} does not open for this role.`);
    await requireGlass(page);
    const misses: string[] = [];
    const measured: string[] = [];
    for (const look of GLASS_LOOKS) {
      await chooseLook(page, look);
      await settle(page);
      const notice = page.locator(UPDATE_NOTICE);
      await expect(notice, 'the pinned unread release brings the notice up').toBeVisible({
        timeout: 20_000,
      });
      // The entrance (200 ms fade and slide) is over before anything is measured.
      await page.waitForTimeout(400);
      for (const material of MATERIALS) {
        await setMaterial(page, material);
        const where = `${route} update card ${look.label} ${material}`;
        const now = await missesNow(context, page, where, UPDATE_NOTICE);
        misses.push(...now.misses);
        if (now.runs === 0) misses.push(`${where}: no text run was measured`);
        const surface = await noticeSurface(page);
        if (material === 'normal') {
          if (!(surface.alpha >= 0.7))
            misses.push(`${where}: fill alpha ${surface.alpha} is under the overlay material's`);
          if (!surface.blurred) misses.push(`${where}: no backdrop blur`);
        } else {
          if (surface.alpha !== 1) misses.push(`${where}: fill alpha ${surface.alpha}, not opaque`);
          if (surface.blurred) misses.push(`${where}: still blurred`);
        }
      }
      await setMaterial(page, 'normal');
      measured.push(look.label);
    }
    misses.push(...coverageProblems(route, measured, requiredLooks(true, false)));
    expect(misses).toEqual([]);
  });
});

/**
 * THE PAGES PEOPLE OPEN FROM A LINK (lab finding, 2026-11-11).
 *
 * These pages have no workspace pane: the scene picture is their ground, and
 * the route lists above hold none of them (each needs a record's token). On
 * the public order page in Day glass at 1440 px "Powered by StockPilot"
 * measured 1.31:1 and the intro line 4.06:1, ink 3 straight on the picture.
 *
 * Each page is opened with the fictional lab token the runner minted (the
 * same variables action-inventory.spec.ts reads; a page with no token is
 * skipped and named), signed out, in Day and Night glass, and every text run
 * is checked as on every other route: 4.5:1 (3:1 large) against the pixels
 * composed behind it, in the three materials, at the top, the middle and the
 * end of the page (the scene is fixed, so the words move over it). The
 * phone-390 project runs it at 390 px, where the public order page prints
 * "Powered by StockPilot" only in the footer.
 */
const LINK_ID = '0d3c2b1a-0000-4000-8000-0000000000a1';
const linkToken = (prefix: string, variable: string): string | null => {
  const token = process.env[variable];
  return token ? `${prefix}${encodeURIComponent(token)}` : null;
};
const LINK_PAGES: Array<{ name: string; path(): string | null; needs: string }> = [
  {
    name: '/r/[token] (the public order page)',
    path: () => linkToken('/r/', 'STAGE5_TOKEN_REQUEST_LINK'),
    needs: 'STAGE5_TOKEN_REQUEST_LINK',
  },
  {
    name: '/orders/sign/[token] (an order’s signature link)',
    path: () => linkToken('/orders/sign/', 'STAGE5_TOKEN_SIGNATURE'),
    needs: 'STAGE5_TOKEN_SIGNATURE',
  },
  {
    name: '/returns/request/[token] (a return link)',
    path: () => linkToken('/returns/request/', 'STAGE5_TOKEN_RETURN'),
    needs: 'STAGE5_TOKEN_RETURN',
  },
  {
    name: '/m/[token] (a maintenance share link)',
    path: () => linkToken('/m/', 'STAGE5_TOKEN_MAINTENANCE_SHARE'),
    needs: 'STAGE5_TOKEN_MAINTENANCE_SHARE',
  },
  { name: '/r/track (the track form)', path: () => '/r/track', needs: '' },
  { name: '/r/confirm (confirmed)', path: () => `/r/confirm?done=${LINK_ID}`, needs: '' },
];

test.describe('signed out: the pages people open from a link', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    const info = test.info();
    test.skip(
      !['anonymous', 'webkit', 'phone-390'].includes(info.project.name),
      'Signed-out pages run in the anonymous (Chrome), webkit and phone-390 projects.',
    );
  });
  for (const link of LINK_PAGES) {
    test(`${link.name}: text holds AA over composed glass`, async ({ browser, baseURL }) => {
      const path = link.path();
      test.skip(path === null, `No lab record: set ${link.needs}.`);
      const misses: string[] = [];
      const measured: string[] = [];
      for (const look of GLASS_LOOKS) {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await arriveSignedOut(context, baseURL!, look);
          const page = await context.newPage();
          const response = await page.goto(path!);
          expect(response?.status(), `${link.name} opens`).toBe(200);
          await page.locator('h1, main').first().waitFor({ state: 'visible', timeout: 15_000 });
          await requireGlass(page);
          await settle(page);
          misses.push(...(await checkRoute(context, page, link.name, look)));
          measured.push(look.label);
        } finally {
          await context.close();
        }
      }
      misses.push(...coverageProblems(link.name, measured, requiredLooks(true, false)));
      expect(misses).toEqual([]);
    });
  }
});
