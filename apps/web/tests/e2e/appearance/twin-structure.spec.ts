import { expect, test, type Page } from '@playwright/test';

import {
  arriveWith,
  buildRollout,
  CONTENT_PATHS,
  cookieFor,
  expectHeadingOutline,
  headingList,
  linkTargets,
  MARKETING_PATHS,
  skipLandingIntro,
  twinOnScreen,
  type Rollout,
} from './site-look';

/**
 * Twin structure and the no-JavaScript check (plans/REVISION-DEFAULT.md R8
 * round 2 finding 11; section 9 item 48). Search now indexes the twin's body
 * under `default`, and BRIEF section 8 asks to keep "metadata, semantic
 * headings, and navigation":
 *  - every twin: exactly one h1, no skipped heading level, no empty heading;
 *  - the six content pages (their words come from the shared modules): the
 *    twin's headings in <main> equal the classic page's, in order, level for
 *    level (the site chrome differs by design: the classic footer's three h3
 *    group titles are, in the twin, the three named navigation landmarks
 *    SiteFooter.dc.html draws; recorded in stage3/site-rows.md);
 *  - every page: every target the classic page links to (its header, body
 *    and footer) is on the twin too, plus Sign in, Contact the team and the
 *    invite-only words; a landing section anchor counts as "/";
 *  - the landing: the glass and classic heading lists are attached to the
 *    report for the owner (the glass landing's words are the board's, by
 *    design).
 * No JavaScript: only the head script sets data-appearance, so the visitor
 * gets the twin's markup on classic CSS (accepted, R8). Each twin must still
 * show its h1, its navigation and its calls to action, with none of them
 * overlapping, nothing pushed off the side, at 1440 and 390 px (screenshots
 * attached).
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * app/(site-glass)/glass-site/twins.test.tsx.
 */

test.use({ storageState: { cookies: [], origins: [] } });

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

async function open(page: Page, baseURL: string, path: string, glass: boolean) {
  await arriveWith(page.context(), baseURL, cookieFor(rollout, glass ? 'liquid-glass' : 'classic'));
  await skipLandingIntro(page);
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  expect(await twinOnScreen(page), `${path} glass=${glass}`).toBe(glass);
}

for (const path of MARKETING_PATHS) {
  test(`${path}: the twin keeps the classic page's outline and every way out`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(rollout === 'off', 'off: no twin is served');
    await page.setViewportSize({ width: 1440, height: 1000 });

    await open(page, baseURL!, path, false);
    const classicHeadings = await headingList(page);
    const classicMain = await headingList(page, 'main');
    const classicTargets = await linkTargets(page);

    await open(page, baseURL!, path, true);
    const twinHeadings = await headingList(page);
    const twinMain = await headingList(page, 'main');
    const twinTargets = await linkTargets(page);

    expectHeadingOutline(twinHeadings);
    if ((CONTENT_PATHS as readonly string[]).includes(path)) {
      expect(classicMain.length, `${path}: the classic page has its own headings`).toBeGreaterThan(
        0,
      );
      expect(twinMain).toEqual(classicMain);
    } else {
      await testInfo.attach('landing-headings.json', {
        body: JSON.stringify({ classic: classicHeadings, glass: twinHeadings }, null, 2),
        contentType: 'application/json',
      });
    }
    expect(classicTargets.filter((t) => !twinTargets.includes(t))).toEqual([]);
    for (const target of ['/signin', '/contact']) expect(twinTargets, target).toContain(target);
    await expect(page.getByText(/invite-only/iu).first()).toBeAttached();
  });
}

test.describe('no JavaScript: the twin markup on classic CSS stays usable', () => {
  test.use({ javaScriptEnabled: false });

  for (const width of [1440, 390]) {
    for (const path of MARKETING_PATHS) {
      test(`${path} at ${width} px: h1, navigation and calls to action shown, none overlapping`, async ({
        page,
        baseURL,
      }, testInfo) => {
        test.skip(rollout === 'off', 'off: no twin is served');
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await arriveWith(page.context(), baseURL!, cookieFor(rollout, 'liquid-glass'));
        await page.goto(path);
        expect(await twinOnScreen(page)).toBe(true);
        // Without the head script nothing marks <html> as glass.
        expect(
          await page.evaluate(() => document.documentElement.hasAttribute('data-appearance')),
        ).toBe(false);

        await expect(page.locator('h1')).toHaveCount(1);
        await expect(page.locator('h1')).toBeVisible();
        const nav = page.getByRole('navigation', { name: 'Primary' });
        await expect(nav).toBeVisible();
        const ctas = [
          nav.getByRole('link', { name: 'Sign in', exact: true }),
          nav.getByRole('link', { name: 'StockPilot home' }),
          ...(await nav.getByRole('link').all()),
        ];
        const boxes: { name: string; x: number; y: number; w: number; h: number }[] = [];
        for (const cta of ctas) {
          await expect(cta).toBeVisible();
          const box = await cta.boundingBox();
          expect(box, 'a call to action has a box').not.toBeNull();
          expect(box!.width).toBeGreaterThan(0);
          expect(box!.height).toBeGreaterThan(0);
          boxes.push({
            name: (await cta.innerText()) || ((await cta.getAttribute('aria-label')) ?? ''),
            x: box!.x,
            y: box!.y,
            w: box!.width,
            h: box!.height,
          });
        }
        const unique = boxes.filter(
          (b, i) => boxes.findIndex((o) => o.x === b.x && o.y === b.y) === i,
        );
        for (let i = 0; i < unique.length; i += 1) {
          for (let j = i + 1; j < unique.length; j += 1) {
            const a = unique[i]!;
            const b = unique[j]!;
            const overlap =
              a.x < b.x + b.w - 1 &&
              b.x < a.x + a.w - 1 &&
              a.y < b.y + b.h - 1 &&
              b.y < a.y + a.h - 1;
            expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
          }
        }
        // Nothing pushed off the side: no sideways scroll.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
        // The phone menu needs JavaScript, so its button stays out of the way.
        await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
        await testInfo.attach(`nojs-${path.replace(/\//gu, '_') || 'root'}-${width}.png`, {
          body: await page.screenshot({ fullPage: false }),
          contentType: 'image/png',
        });
      });
    }
  }
});
