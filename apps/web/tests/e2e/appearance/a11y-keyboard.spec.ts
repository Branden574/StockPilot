import { expect, test, type Page, type TestInfo } from '@playwright/test';

import {
  focusIndicatorProblems,
  ringProblems,
  type ComputedRing,
  type RingVariant,
} from './a11y-math';
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
import { coverageProblems, MIN_TAB_STOPS, requiredLooks } from './stage5-visit';

/**
 * PLAN 8.3-2: A KEYBOARD-ONLY PASS WITH THE GLASS FOCUS RING.
 *
 * On every drawn route, in Day glass and Night glass, each also with the
 * contrast material (`prefers-contrast: more` emulated), Tab is pressed
 * through the page (up to 80 stops, until focus comes back round). At every
 * stop:
 *  - the focused element shows a VISIBLE focus indicator (WCAG 2.4.7): an
 *    outline with a colour that is not transparent, a box-shadow that paints
 *    a colour and is new on focus (the same element's style is read again
 *    once focus has moved on, so an always-on material shadow does not count),
 *    or a border colour that changes on focus (a11y-math.ts
 *    focusIndicatorProblems);
 *  - where Liquid Glass draws its own ring (a glass button, a segment, the
 *    sidebar, top bar and phone menu, the state screens' links:
 *    primitives.css, shell.css, states.css), the computed ring is the
 *    variant's (a11y-math.ts FOCUS_RING: Day #0B7A5C 2 px, Night #56D6A9 2 px,
 *    contrast 3 px #101412 / #FFFFFF; 2 px offset, a segment drawn inside its
 *    edge), and a glass field shows its 3 px halo instead, painted and new on
 *    focus; in the contrast material, where the halo is transparent by
 *    design, the field's border changes and holds 3:1 against the surface;
 *  - focus never lands on something hidden (zero size or invisible);
 *  - the walk reached at least MIN_TAB_STOPS stops in each look, and both
 *    glass looks were walked (a walk that measured nothing fails).
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
  /** The opaque background around the element (the nearest ancestor that paints one). */
  surface: string | null;
  /** The same element's style once focus has left it (filled in at the next stop). */
  unfocused: ComputedRing | null;
}

/**
 * Reads the focused element (who it is, which ring rule applies, its
 * computed ring) and the PREVIOUS stop's element as it looks now that focus
 * has left it. Running transitions are finished first, so neither read is
 * caught half way through a fade.
 */
async function focused(page: Page): Promise<{ stop: Stop | null; previous: ComputedRing | null }> {
  return page.evaluate(() => {
    const w = window as unknown as { __s5FocusPrev?: Element | null };
    const read = (node: Element) => {
      for (const a of node.getAnimations?.() ?? []) {
        try {
          a.finish();
        } catch {
          /* an endless animation cannot finish: read it as it is */
        }
      }
      const cs = getComputedStyle(node);
      return {
        outlineStyle: cs.outlineStyle,
        outlineColor: cs.outlineColor,
        outlineWidth: cs.outlineWidth,
        outlineOffset: cs.outlineOffset,
        boxShadow: cs.boxShadow,
        borderColor: cs.borderTopColor,
      };
    };
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    const prev = w.__s5FocusPrev ?? null;
    const previous = prev && prev !== el && prev.isConnected ? read(prev) : null;
    if (!el || el === document.body || el === document.documentElement) {
      w.__s5FocusPrev = null;
      return { stop: null, previous };
    }
    w.__s5FocusPrev = el;
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
    let surface: string | null = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const bg = getComputedStyle(p).backgroundColor;
      const m = /rgba?\(([^)]*)\)/u.exec(bg);
      const alpha = m ? Number(m[1]!.split(/[\s,/]+/u).filter(Boolean)[3] ?? '1') : 0;
      if (alpha >= 0.99) {
        surface = bg;
        break;
      }
    }
    const name =
      el.getAttribute('aria-label') ??
      (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40);
    return {
      stop: {
        id: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}"`,
        kind,
        visible:
          box.width > 0 && box.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
        ring: read(el),
        surface,
        unfocused: null,
      },
      previous,
    };
  });
}

/** Judges one stop once its unfocused style is known (or not: null). */
function stopProblems(stop: Stop, variant: RingVariant): string[] {
  if (!stop.visible) return [`${stop.id}: focus on something hidden`];
  const out = focusIndicatorProblems(stop.ring, stop.unfocused).map((p) => `${stop.id}: ${p}`);
  if (stop.kind !== 'other')
    for (const p of ringProblems(stop.ring, variant, stop.kind, {
      unfocused: stop.unfocused,
      surface: stop.surface,
    }))
      out.push(`${stop.id}: ${p}`);
  return out;
}

/** Tabs through the page; returns every problem found and how many stops were reached. */
async function tabWalk(
  page: Page,
  variant: RingVariant,
): Promise<{ problems: string[]; stops: number }> {
  const problems: string[] = [];
  await page
    .locator('body')
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  await page.evaluate(() => {
    (window as unknown as { __s5FocusPrev?: Element | null }).__s5FocusPrev = null;
  });
  let first: string | null = null;
  let pending: Stop | null = null;
  let stops = 0;
  for (let i = 0; i < MAX_STOPS; i += 1) {
    await page.keyboard.press('Tab');
    const { stop, previous } = await focused(page);
    if (pending) {
      pending.unfocused = previous;
      problems.push(...stopProblems(pending, variant));
      pending = null;
    }
    if (!stop) continue;
    if (first === null) first = stop.id;
    else if (stop.id === first && i > 2) break;
    stops += 1;
    pending = stop;
  }
  if (pending) {
    // The last stop: move focus off it and read it again.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    pending.unfocused = (await focused(page)).previous;
    problems.push(...stopProblems(pending, variant));
  }
  if (stops < MIN_TAB_STOPS)
    problems.push(
      `the walk reached ${stops} Tab stops (fewer than ${MIN_TAB_STOPS}): nothing to judge`,
    );
  return { problems, stops };
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
        const walked: string[] = [];
        for (const look of GLASS_LOOKS) {
          await chooseLook(page, look);
          await settle(page);
          const walk = await tabWalk(page, variantOf(look, contrast));
          for (const p of walk.problems) all.push(`${look.label}: ${p}`);
          walked.push(look.label);
        }
        all.push(...coverageProblems(route, walked, requiredLooks(true, false)));
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
        const walked: string[] = [];
        for (const look of GLASS_LOOKS) {
          const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
          try {
            await arriveSignedOut(context, baseURL!, look);
            const page = await context.newPage();
            await page.emulateMedia({ contrast: contrast ? 'more' : 'no-preference' });
            // A signed-out page opens for everyone: visit() fails the test on any error status.
            if (!(await visit(page, route, null))) continue;
            await requireGlass(page);
            const walk = await tabWalk(page, variantOf(look, contrast));
            for (const p of walk.problems) all.push(`${look.label}: ${p}`);
            walked.push(look.label);
          } finally {
            await context.close();
          }
        }
        all.push(...coverageProblems(route, walked, requiredLooks(true, false)));
        expect(all).toEqual([]);
      });
    }
  }
});
