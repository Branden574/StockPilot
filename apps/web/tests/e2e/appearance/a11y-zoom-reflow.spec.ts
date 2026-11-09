import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { chooseLook, glassBuild, settle } from './look';
import { arriveSignedOut, requireGlass, visit, type NamedLook } from './stage5-pages';

/**
 * PLAN 8.3-5: 200% ZOOM, TEXT-SPACING OVERRIDE, REFLOW AT 320 PX.
 *
 *  - 200% zoom: a 1440 x 900 window at 200% lays out in a 720 x 450 CSS px
 *    viewport, which is what this spec sets (deviceScaleFactor 2 keeps the
 *    pixels); reflow (WCAG 1.4.10): a 320 x 640 viewport;
 *    in both, the document does not scroll sideways (a data table may scroll
 *    inside its own box, which 1.4.10 allows), and the level-one heading is
 *    on screen and inside the viewport's width;
 *  - text spacing (WCAG 1.4.12): line height 1.5, paragraph spacing 2x,
 *    letter spacing 0.12em, word spacing 0.16em injected; no element that
 *    clips (overflow hidden or clip) cuts its own text.
 * Glass must add no failure Classic of the same theme does not have on the
 * same route: Classic's own (pre-existing) failures are attached for the
 * integrator and do not fail this run.
 *
 * Lab command:
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome --project=anonymous a11y-zoom-reflow.spec.ts
 */

const SIGNED_IN = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/reports/book-order-totals',
  '/dashboard/cycle-counts',
] as const;
const SIGNED_OUT = ['/', '/pricing', '/support', '/signin'] as const;
const SIZES = [
  { label: '200% zoom', width: 720, height: 450 },
  { label: 'reflow 320', width: 320, height: 640 },
] as const;
const PAIRS: readonly (readonly [NamedLook, NamedLook])[] = [
  [
    { label: 'Light', design: 'classic', theme: 'light' },
    { label: 'Day glass', design: 'liquid-glass', theme: 'light' },
  ],
  [
    { label: 'Dark', design: 'classic', theme: 'dark' },
    { label: 'Night glass', design: 'liquid-glass', theme: 'dark' },
  ],
];

const TEXT_SPACING = `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p { margin-bottom: 2em !important; }`;

/** Failures on the page as it is now (stable names, so Classic and glass compare). */
async function failures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const doc = document.scrollingElement ?? document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1)
      out.push(`the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
    const h1 = document.querySelector('h1');
    if (h1) {
      const r = h1.getBoundingClientRect();
      if (r.width === 0 || r.left < -1 || r.right > innerWidth + 1)
        out.push('the heading is outside the viewport width');
    }
    return out;
  });
}

async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const own = [...el.childNodes].some(
        (c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim(),
      );
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const clips = /hidden|clip/u.test(cs.overflowX + cs.overflowY);
      if (!clips) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        const text = (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 30);
        out.add(`${el.tagName.toLowerCase()} "${text}" clips its text`);
      }
    }
    return [...out].slice(0, 50);
  });
}

async function check(page: Page, label: string): Promise<string[]> {
  const list = (await failures(page)).map((f) => `${label}: ${f}`);
  const style = await page.addStyleTag({ content: TEXT_SPACING });
  await page.waitForTimeout(150);
  list.push(...(await clipped(page)).map((f) => `${label} text spacing: ${f}`));
  await style.evaluate((el) => (el as Element).remove());
  return list;
}

/** Glass-only failures of one size; Classic's are attached. */
async function compare(classic: string[], glass: string[], where: string): Promise<string[]> {
  const strip = (s: string) => s.replace(/^[^:]*: /u, '');
  const base = new Set(classic.map(strip));
  if (classic.length)
    test.info().annotations.push({
      type: 'classic-findings',
      description: `${where}: ${classic.join('; ')}`,
    });
  return glass.filter((g) => !base.has(strip(g)));
}

const signedIn = (info: TestInfo) => typeof info.project.use.storageState === 'string';

test.describe('signed in', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
      'Dashboard routes only.',
    );
    test.skip(info.project.name === 'phone-390', 'The spec sets its own viewports.');
  });
  for (const route of SIGNED_IN) {
    for (const size of SIZES) {
      test(`${route}: ${size.label}`, async ({ page }) => {
        if (!(await visit(page, route, null)))
          test.skip(true, `${route} does not open for this role.`);
        await requireGlass(page);
        // The header menu is chosen at the desktop width (a narrow window folds it into the phone menu).
        const at = async (look: NamedLook) => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await chooseLook(page, look);
          await page.setViewportSize({ width: size.width, height: size.height });
          await settle(page);
          return check(page, look.label);
        };
        const extra: string[] = [];
        for (const [classicLook, glassLook] of PAIRS) {
          const c = await at(classicLook);
          const g = await at(glassLook);
          extra.push(...(await compare(c, g, `${route} ${size.label} ${classicLook.label}`)));
        }
        expect(extra).toEqual([]);
      });
    }
  }
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.beforeEach(() => {
    const info = test.info();
    test.skip(info.project.name !== 'anonymous', 'Signed-out routes run in the anonymous project.');
  });
  for (const route of SIGNED_OUT) {
    for (const size of SIZES) {
      test(`${route}: ${size.label}`, async ({ browser, baseURL }) => {
        const extra: string[] = [];
        for (const [classicLook, glassLook] of PAIRS) {
          const results: string[][] = [];
          for (const look of [classicLook, glassLook]) {
            const context = await browser.newContext({
              storageState: { cookies: [], origins: [] },
              viewport: { width: size.width, height: size.height },
              deviceScaleFactor: 2,
            });
            try {
              await arriveSignedOut(context, baseURL!, look);
              const page = await context.newPage();
              if (!(await visit(page, route, null))) {
                results.push([]);
                continue;
              }
              if (look.design === 'liquid-glass' && !(await glassBuild(page)))
                test.skip(true, 'This build does not offer Liquid Glass.');
              results.push(await check(page, look.label));
            } finally {
              await context.close();
            }
          }
          extra.push(
            ...(await compare(
              results[0] ?? [],
              results[1] ?? [],
              `${route} ${size.label} ${classicLook.label}`,
            )),
          );
        }
        expect(extra).toEqual([]);
      });
    }
  }
});
