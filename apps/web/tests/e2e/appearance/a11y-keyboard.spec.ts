import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { ringProblems, type ComputedRing, type RingVariant } from './a11y-math';
import { chooseLook, settle } from './look';
import {
  arriveSignedOut,
  GLASS_LOOKS,
  requireGlass,
  SIGNED_IN_ROUTES,
  SIGNED_OUT_ROUTES,
  visit,
  type NamedLook,
} from './stage5-pages';

/**
 * PLAN 8.3-2: A KEYBOARD-ONLY PASS WITH THE GLASS FOCUS RING.
 *
 * On every drawn route, in Day glass and Night glass, each also with the
 * contrast material (`prefers-contrast: more` emulated), Tab is pressed
 * through the page (up to 80 stops, until focus comes back round). At every
 * stop:
 *  - the focused element shows a focus indicator (an outline or a box
 *    shadow that is not "none"; WCAG 2.4.7);
 *  - where Liquid Glass draws its own ring (a glass button, a segment, the
 *    sidebar, top bar and phone menu, the state screens' links:
 *    primitives.css, shell.css, states.css), the computed ring is the
 *    variant's (a11y-math.ts FOCUS_RING: Day #0B7A5C 2 px, Night #56D6A9 2 px,
 *    contrast 3 px #101412 / #FFFFFF; 2 px offset, a segment drawn inside its
 *    edge), and a glass field shows its 3 px halo instead;
 *  - focus never lands on something hidden (zero size or invisible).
 * Focus RESTORATION after dialogs (Escape returns focus to the trigger) is
 * asserted in glass by the transition specs' dialog cases (items-, orders-,
 * admin- and ops-transitions.spec.ts), which this run executes too.
 *
 * Lab command:
 *   STAGE5_ROLE=manager PLAYWRIGHT_BASE_URL=http://127.0.0.1:3400 \
 *     pnpm exec playwright test -c playwright.stage5.config.ts --project=chrome a11y-keyboard.spec.ts
 * Skips in a build without Liquid Glass.
 */

const MAX_STOPS = 80;
const KEYBOARD_ROUTES = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/reports',
  '/dashboard/reports/book-order-totals',
  '/dashboard/cycle-counts',
  '/dashboard/purchase-orders',
  '/dashboard/returns',
] as const satisfies readonly (typeof SIGNED_IN_ROUTES)[number][];

interface Stop {
  id: string;
  kind: 'outline' | 'inset' | 'halo' | 'other';
  visible: boolean;
  ring: ComputedRing;
}

/** Reads the focused element: who it is, which ring rule applies, its computed ring. */
async function focused(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const glassRoot = document.documentElement.getAttribute('data-appearance') === 'liquid-glass';
    let kind: 'outline' | 'inset' | 'halo' | 'other' = 'other';
    if (glassRoot) {
      if (el.matches('[data-glass="input"], [data-glass="select"]')) kind = 'halo';
      else if (el.matches('[data-glass="seg"] > *')) kind = 'inset';
      else if (
        el.matches(
          '[data-glass="button"], :is([data-glass="sidebar"], [data-glass="topbar"], [data-glass="navsheet"]) *, :is([data-glass="state-screen"], [data-glass="error-frame"], [data-glass="state-page"]) a:not([data-glass])',
        )
      )
        kind = 'outline';
    }
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const name =
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
    return {
      id: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}"`,
      kind,
      visible: box.width > 0 && box.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
      ring: {
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        outlineWidth: cs.outlineWidth,
        outlineOffset: cs.outlineOffset,
        boxShadow: cs.boxShadow,
      },
    };
  });
}

/** Tabs through the page and returns every problem found. */
async function tabWalk(page: Page, variant: RingVariant): Promise<string[]> {
  const problems: string[] = [];
  await page
    .locator('body')
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  let first: string | null = null;
  for (let i = 0; i < MAX_STOPS; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await focused(page);
    if (!stop) continue;
    if (first === null) first = stop.id;
    else if (stop.id === first && i > 2) break;
    if (!stop.visible) {
      problems.push(`${stop.id}: focus on something hidden`);
      continue;
    }
    const indicator =
      (stop.ring.outlineStyle !== 'none' && parseFloat(stop.ring.outlineWidth) > 0) ||
      stop.ring.boxShadow !== 'none';
    if (!indicator) problems.push(`${stop.id}: no focus indicator`);
    if (stop.kind !== 'other')
      for (const p of ringProblems(stop.ring, variant, stop.kind))
        problems.push(`${stop.id}: ${p}`);
  }
  return problems;
}

const variantOf = (look: NamedLook, contrast: boolean): RingVariant =>
  contrast
    ? look.theme === 'dark'
      ? 'contrast-night'
      : 'contrast-day'
    : look.theme === 'dark'
      ? 'night'
      : 'day';

const signedIn = (info: TestInfo) => typeof info.project.use.storageState === 'string';

test.describe('signed in', () => {
  test.beforeEach(() => {
    const info = test.info();
    test.skip(!signedIn(info), 'This project has no session.');
    test.skip(
      info.project.name === 'phone-390',
      'The header menu is a desktop control; phone layouts have their own specs.',
    );
    test.skip(
      ['platform', 'portal'].includes(process.env.STAGE5_ROLE ?? ''),
      'Dashboard routes only.',
    );
  });
  for (const route of KEYBOARD_ROUTES) {
    for (const contrast of [false, true]) {
      test(`${route}: keyboard walk and the glass ring${contrast ? ' (contrast material)' : ''}`, async ({
        page,
      }) => {
        await page.emulateMedia({ contrast: contrast ? 'more' : 'no-preference' });
        if (!(await visit(page, route, null)))
          test.skip(true, `${route} does not open for this role.`);
        await requireGlass(page);
        const all: string[] = [];
        for (const look of GLASS_LOOKS) {
          await chooseLook(page, look);
          await settle(page);
          for (const p of await tabWalk(page, variantOf(look, contrast)))
            all.push(`${look.label}: ${p}`);
        }
        expect(all).toEqual([]);
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
  for (const route of SIGNED_OUT_ROUTES) {
    for (const contrast of [false, true]) {
      test(`${route}: keyboard walk and the glass ring${contrast ? ' (contrast material)' : ''}`, async ({
        browser,
        baseURL,
      }) => {
        const all: string[] = [];
        for (const look of GLASS_LOOKS) {
          const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
          try {
            await arriveSignedOut(context, baseURL!, look);
            const page = await context.newPage();
            await page.emulateMedia({ contrast: contrast ? 'more' : 'no-preference' });
            if (!(await visit(page, route, null))) continue;
            await requireGlass(page);
            for (const p of await tabWalk(page, variantOf(look, contrast)))
              all.push(`${look.label}: ${p}`);
          } finally {
            await context.close();
          }
        }
        expect(all).toEqual([]);
      });
    }
  }
});
