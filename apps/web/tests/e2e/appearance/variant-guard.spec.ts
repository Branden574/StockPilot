import { expect, test, type Page } from '@playwright/test';

import {
  arriveWith,
  buildRollout,
  chooseLook,
  cookieFor,
  flaggedFrames,
  sampleFrames,
  shownLook,
  skipLandingIntro,
  twinOnScreen,
  waitForTwin,
  type Design,
  type Rollout,
} from './site-look';

/**
 * The marketing variant guard (plans/REVISION-DEFAULT.md R8 round 2 finding
 * 2; section 9 item 45). The client router cache keeps visited and prefetched
 * marketing payloads for up to 180 s (next.config.ts staleTimes) and
 * Back/Forward reuses them; the back/forward cache keeps a whole frozen page.
 * After a Design chosen on another page, the guard must show the twin the
 * cookie selects, never a frame of the other one, and never a twin on the
 * other design's CSS:
 *  1. router cache: /signin, then / through the sign-in shell's home link (a
 *     client navigation, so / and the Support link's prefetch land in the
 *     router cache), Back to /signin, choose the other Design there, Forward
 *     to / (history traversal reuses the cache), then Support: each page the
 *     chosen design, within 180 s (the marketing links to /signin are
 *     whole-document loads, so history is the client way back to /);
 *  2. the reverse direction;
 *  3. Back after a whole-document link: / then SiteNav's Sign in (a
 *     whole-document link), choose Classic on /signin, Back. Playwright starts
 *     Chromium with --disable-back-forward-cache, so here Back reads the
 *     document again, from the HTTP cache: the twin's HTML under the classic
 *     cookie (a history load reuses the cached response, which does not vary
 *     on the cookie). The twin layout's first-paint check
 *     (components/theme/twin-first-paint.ts) hides it before it paints and
 *     the guard refreshes it to the classic page. A browser that keeps the
 *     page in its back/forward cache restores it frozen instead; that restore
 *     (pageshow persisted) is the unit half's;
 *  4. offline: the refresh cannot land, so within 2 s the page is shown as it
 *     is, its attribute following the twin on screen (coherent), and the
 *     choice applies at the next navigation.
 * Each frame painted while <html> is visible on a marketing path is sampled
 * (requestAnimationFrame): a frame showing the twin the cookie does not select
 * is "wrong", and one whose glass attribute disagrees with the twin on screen
 * is "incoherent". Cases 1, 2 and 3 allow neither; 4 allows no incoherent
 * frame (an offline page shows its own design until it can change).
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * components/theme/appearance-provider.test.tsx (the guard's states, the
 * back/forward cache restore) and components/theme/twin-first-paint.test.tsx.
 */

test.use({ storageState: { cookies: [], origins: [] } });

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

test.beforeEach(async ({ page }) => {
  test.skip(rollout === 'off', 'off: no twins, no guard');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await skipLandingIntro(page);
  await sampleFrames(page, rollout);
});

const other = (design: Design): Design => (design === 'classic' ? 'liquid-glass' : 'classic');

/**
 * /signin in `from`, then / through the sign-in shell's home link (a client
 * navigation: / lands in the router cache, and its Support link prefetches),
 * then Back to /signin (the same document).
 */
async function visitLandingThenSignIn(page: Page, baseURL: string, from: Design) {
  await arriveWith(page.context(), baseURL, cookieFor(rollout, from));
  await page.goto('/signin');
  await page.getByRole('link', { name: 'StockPilot home' }).first().click();
  await page.waitForURL((url) => url.pathname === '/');
  await waitForTwin(page, from);
  await page.goBack();
  await page.waitForURL('**/signin');
}

for (const from of ['liquid-glass', 'classic'] as const) {
  test(`router cache: ${from} at /, ${other(from)} chosen on /signin, Forward to / and on to Support show ${other(from)} only`, async ({
    page,
    baseURL,
  }) => {
    const started = Date.now();
    await visitLandingThenSignIn(page, baseURL!, from);
    const to = other(from);
    await chooseLook(page, { design: to, theme: (await shownLook(page)).theme });
    await flaggedFrames(page, true);

    await page.goForward();
    await page.waitForURL((url) => url.pathname === '/');
    await waitForTwin(page, to);
    expect((await shownLook(page)).design).toBe(to);

    await page.getByRole('link', { name: 'Support', exact: true }).first().click();
    await page.waitForURL('**/support');
    await waitForTwin(page, to);
    expect((await shownLook(page)).design).toBe(to);
    expect(Date.now() - started, 'inside the router cache’s 180 s').toBeLessThan(180_000);

    const frames = await flaggedFrames(page);
    expect(frames.wrongTwin, 'a frame of the other design').toEqual([]);
    expect(frames.incoherent, 'a twin on the other design’s CSS').toEqual([]);
  });
}

test('Back to a landing left by a whole-document link, after Classic was chosen on /signin: no frame of the twin, then the classic page', async ({
  page,
  baseURL,
}) => {
  await arriveWith(page.context(), baseURL!, cookieFor(rollout, 'liquid-glass'));
  await page.goto('/');
  expect(await twinOnScreen(page)).toBe(true);
  // SiteNav's Sign in is a whole-document link: / may be kept in the back/forward cache.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Sign in', exact: true })
    .click();
  await page.waitForURL('**/signin');
  await chooseLook(page, { design: 'classic', theme: (await shownLook(page)).theme });
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await waitForTwin(page, 'classic');
  expect((await shownLook(page)).design).toBe('classic');
  const frames = await flaggedFrames(page);
  expect(frames.wrongTwin, 'a frame of the glass twin under Classic').toEqual([]);
  expect(frames.incoherent, 'the twin on the classic CSS').toEqual([]);
});

test('offline: when the refresh cannot land, the page is shown within 2 s as it is, attribute and twin agreeing', async ({
  page,
  baseURL,
}) => {
  await visitLandingThenSignIn(page, baseURL!, 'liquid-glass');
  await chooseLook(page, { design: 'classic', theme: (await shownLook(page)).theme });
  await page.context().setOffline(true);
  try {
    await page.goForward();
    await page.waitForURL((url) => url.pathname === '/');
    // The guard's 2 s cap, then the page shows.
    await page.waitForFunction(
      () => document.head.querySelector('style[data-lg-variant-guard]') === null,
      undefined,
      { timeout: 4_000 },
    );
    const twin = await twinOnScreen(page);
    expect((await shownLook(page)).design).toBe(twin ? 'liquid-glass' : 'classic');
    expect((await flaggedFrames(page)).incoherent).toEqual([]);
  } finally {
    await page.context().setOffline(false);
  }
  // Back online, the next navigation shows the chosen design.
  await page.goto('/privacy');
  await waitForTwin(page, 'classic');
  expect((await shownLook(page)).design).toBe('classic');
});
