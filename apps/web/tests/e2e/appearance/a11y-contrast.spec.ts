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

/** Every contrast miss on the viewport now. */
async function missesNow(context: BrowserContext, page: Page, where: string): Promise<string[]> {
  const runs = await textRuns(page);
  if (runs.length === 0) return [];
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
  return misses;
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
    for (const y of await scrollPositions(page)) {
      await scrollTo(page, y);
      misses.push(...(await missesNow(context, page, `${route} ${look.label} ${material} @${y}`)));
    }
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
      for (const look of GLASS_LOOKS) {
        await chooseLook(page, look);
        await settle(page);
        misses.push(...(await checkRoute(context, page, route, look)));
      }
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
      for (const look of GLASS_LOOKS) {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await arriveSignedOut(context, baseURL!, look);
          const page = await context.newPage();
          if (!(await visit(page, route, null))) continue;
          await requireGlass(page);
          misses.push(...(await checkRoute(context, page, route, look)));
        } finally {
          await context.close();
        }
      }
      expect(misses).toEqual([]);
    });
  }
});
