import { expect, test } from '@playwright/test';

import {
  arriveWith,
  buildRollout,
  chooseLook,
  cookieFor,
  fetchAs,
  MARKETING_PATHS,
  shownLook,
  TWIN_MARKER,
  twinPath,
  twinSelected,
  waitForTwin,
  type Rollout,
} from './site-look';

/**
 * The marketing rewrites and the cache (IMPLEMENTATION-PLAN.md 4.6 M3, 2.3;
 * plans/REVISION-DEFAULT.md R8; stage 3 tests "rewrite and cache"), against a
 * `next start` server of the build under test, as an anonymous visitor:
 *  - each of the 7 paths serves its glass twin exactly when the rollout and
 *    the sp_style cookie select it (default: unless classic; opt-in: only
 *    liquid-glass; off: never), at the public address, with a 200;
 *  - a direct /glass-site URL is redirected (307) to its public path in every
 *    rollout, whatever the cookie, so a twin address is never indexed and
 *    never forces glass on anyone (the Location resolved against the address
 *    asked for, so the bare /glass-site cannot point at itself), and a
 *    percent-encoded twin address never serves a twin;
 *  - both variants are static: the same bytes on every request, cacheable
 *    headers, and never the other variant's page (no cross-serving), however
 *    the requests interleave;
 *  - every other spelling the rewrites take (one trailing slash, any case:
 *    FOLLOWUPS F7) serves the same twin under the same cookies, and the head
 *    script and the variant guard take it too; a percent-encoded letter or a
 *    doubled slash never serves a twin.
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * components/theme/appearance-flag.test.ts (the rules per rollout, and the
 * spellings against Next's own matchers).
 */

const COOKIES: Array<string | null> = [null, 'classic', 'liquid-glass', 'not-a-design'];

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

test('each marketing path serves its twin exactly when the rollout and the cookie select it', async ({
  request,
}) => {
  for (const path of MARKETING_PATHS) {
    for (const cookie of COOKIES) {
      const response = await fetchAs(request, path, cookie);
      expect(response.status(), `${path} cookie=${cookie}`).toBe(200);
      const html = await response.text();
      expect(html.includes(TWIN_MARKER), `${rollout} ${path} cookie=${cookie}`).toBe(
        twinSelected(rollout, cookie),
      );
      // The public address: a rewrite never shows /glass-site to anyone.
      expect(new URL(response.url()).pathname).toBe(path);
    }
  }
});

test('a direct /glass-site URL redirects (307) to its public path, in every rollout, whatever the cookie', async ({
  request,
  baseURL,
}) => {
  // A Location is resolved against the address that was asked for, as a
  // browser does: an empty one (next start's answer for /glass-site under the
  // single "/glass-site/:path*" rule) would send /glass-site to itself.
  const target = (asked: string, location: string | undefined) => {
    expect(location, `${asked}: a Location header`).toBeTruthy();
    return new URL(location!, new URL(asked, baseURL)).pathname;
  };
  for (const path of MARKETING_PATHS) {
    for (const cookie of COOKIES) {
      const response = await fetchAs(request, twinPath(path), cookie, 0);
      expect(response.status(), `${twinPath(path)} cookie=${cookie}`).toBe(307);
      expect(target(twinPath(path), response.headers().location)).toBe(path);
    }
  }
  // Below a twin too (nothing is served under /glass-site at all).
  const deep = await fetchAs(request, '/glass-site/contact/anything', null, 0);
  expect(deep.status()).toBe(307);
  expect(target('/glass-site/contact/anything', deep.headers().location)).toBe('/contact/anything');
});

test('a percent-encoded twin address never serves a twin (stage 3 review, finding 3)', async ({
  request,
  baseURL,
}) => {
  // Next's filesystem lookup also tries the decoded path in production, while
  // the redirect matches the raw one. On a local next start of the default
  // build (2026-11-04) each of these answered 404 with the not-found page and
  // no twin, cookie or none; the lab and a preview must agree. A 307 to the
  // public path is as good; a 200 carrying the twin marker is the defect.
  for (const encoded of [
    '/glass%2Dsite/pricing',
    '/glass%2dsite/pricing',
    '/%67lass-site/pricing',
    '/%67lass-site',
    '/glass-site%2Fpricing',
    '/glass%2Dsite',
  ]) {
    for (const cookie of COOKIES) {
      const response = await fetchAs(request, encoded, cookie, 0);
      const status = response.status();
      const at = `${encoded} cookie=${cookie}: ${status}`;
      if (status === 307 || status === 308) {
        const location = response.headers().location ?? '';
        expect(location, at).not.toBe('');
        expect(new URL(location, new URL(encoded, baseURL)).pathname, at).not.toMatch(
          /glass-site|glass%2d|%67lass/iu,
        );
      } else {
        expect(status, at).toBe(404);
        expect((await response.text()).includes(TWIN_MARKER), at).toBe(false);
      }
    }
  }
});

test('both variants stay static and are never served to the other variant’s visitor', async ({
  request,
}) => {
  test.skip(rollout === 'off', 'off: one variant only (no rewrites)');
  const glassCookie = rollout === 'default' ? null : 'liquid-glass';
  for (const path of MARKETING_PATHS) {
    const bodies = new Map<string, string>();
    // Interleaved, three rounds: classic, glass, classic, glass, ...
    for (let round = 0; round < 3; round += 1) {
      for (const [variant, cookie] of [
        ['classic', 'classic'],
        ['glass', glassCookie],
      ] as const) {
        const response = await fetchAs(request, path, cookie);
        const html = await response.text();
        expect(html.includes(TWIN_MARKER), `${path} ${variant} round ${round}`).toBe(
          variant === 'glass',
        );
        const headers = response.headers();
        const cacheControl = headers['cache-control'] ?? '';
        expect(cacheControl, `${path} ${variant}`).not.toMatch(/no-store|private/u);
        if (headers['x-nextjs-cache']) {
          expect(headers['x-nextjs-cache'], `${path} ${variant}`).toMatch(/HIT|STALE/u);
        }
        // Static: the same bytes every time for the same variant.
        const before = bodies.get(variant);
        if (before === undefined) bodies.set(variant, html);
        else expect(html === before, `${path} ${variant} changed between requests`).toBe(true);
      }
    }
    expect(bodies.get('classic')).not.toBe(bodies.get('glass'));
  }
});

/**
 * FOLLOWUPS F7: Next compiles each marketing rule with an optional trailing
 * slash and no case (/pricing: ^/pricing(?:/)?$, routes-manifest caseSensitive
 * false), and next.config.ts's skipTrailingSlashRedirect lets /pricing/ reach
 * it, so these spellings get the twin as their path does. One case per
 * spelling, covering each of the six non-root paths:
 *  - the server, for every cookie: the twin exactly when the cookie selects
 *    it, the same bytes as at the path as written, at the address asked for
 *    (no redirect); no twin otherwise (the classic page, or a 404 where the
 *    filesystem has no such spelling);
 *  - a browser whose cookie selects glass: the head script added its early
 *    hide (it took the spelling: appearance-flag.ts MARKETING_PATH_PATTERN),
 *    the twin shows in glass, and once Classic is chosen there the variant
 *    guard (isMarketingPath, the same rule) has replaced the twin, so no twin
 *    is left on the classic CSS.
 * Unit half: appearance-flag.test.ts, appearance-script.test.ts and
 * appearance-provider.test.tsx.
 */
const REWRITTEN_SPELLINGS = [
  ['/pricing/', '/pricing'],
  ['/Pricing', '/pricing'],
  ['/PRICING/', '/pricing'],
  ['/terms/', '/terms'],
  ['/Contact/', '/contact'],
  ['/privacy/', '/privacy'],
  ['/SECURITY', '/security'],
  ['/Support/', '/support'],
] as const;

for (const [spelling, path] of REWRITTEN_SPELLINGS) {
  test(`${spelling} (F7): the server serves ${path}’s twin exactly when the cookie selects it, at the address asked for`, async ({
    request,
  }) => {
    for (const cookie of COOKIES) {
      const at = `${spelling} cookie=${cookie}`;
      const response = await fetchAs(request, spelling, cookie, 0);
      const html = await response.text();
      if (twinSelected(rollout, cookie)) {
        expect(response.status(), at).toBe(200);
        expect(new URL(response.url()).pathname, at).toBe(spelling);
        expect(html.includes(TWIN_MARKER), at).toBe(true);
        const asWritten = await fetchAs(request, path, cookie, 0);
        expect(html === (await asWritten.text()), `${at}: the same twin as ${path}`).toBe(true);
      } else {
        expect(html.includes(TWIN_MARKER), at).toBe(false);
      }
    }
  });
}

test.describe('the head script and the variant guard take every spelling the rewrites take (F7)', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [spelling] of REWRITTEN_SPELLINGS) {
    test(`${spelling}: the early hide, the twin in glass, and after Classic is chosen there no twin is left`, async ({
      page,
      baseURL,
    }) => {
      test.skip(rollout === 'off', 'off: no rewrites, no head script, no guard');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await arriveWith(page.context(), baseURL!, cookieFor(rollout, 'liquid-glass'));
      // Records whether the head script added its early hide; the twin's own
      // first-paint script removes it at once, so only the record shows it.
      await page.addInitScript(() => {
        const w = window as unknown as { __lgEarlyHide?: boolean };
        w.__lgEarlyHide = false;
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof HTMLStyleElement && node.hasAttribute('data-lg-variant-early')) {
                w.__lgEarlyHide = true;
              }
            }
          }
        }).observe(document, { childList: true, subtree: true });
      });
      const response = await page.goto(spelling);
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(spelling);
      await waitForTwin(page, 'liquid-glass');
      expect((await shownLook(page)).design).toBe('liquid-glass');
      expect(
        await page.evaluate(() => (window as unknown as { __lgEarlyHide?: boolean }).__lgEarlyHide),
        'the head script took the spelling',
      ).toBe(true);

      const { theme } = await shownLook(page);
      await chooseLook(page, { design: 'classic', theme });
      // The guard took the spelling: it refreshed the page under the classic
      // cookie, so the twin is gone and its hide removed.
      await waitForTwin(page, 'classic');
      expect((await shownLook(page)).design).toBe('classic');
      expect(new URL(page.url()).pathname).toBe(spelling);
    });
  }
});

for (const spelling of ['/pric%69ng', '//pricing']) {
  test(`${spelling} (F7): no rewrite takes it, so it never serves a twin`, async ({
    request,
    baseURL,
  }) => {
    // The page's own origin, so //pricing stays a path (alone it would name a host).
    const url = `${new URL(baseURL!).origin}${spelling}`;
    expect(new URL(url).pathname).toBe(spelling);
    for (const cookie of COOKIES) {
      const response = await fetchAs(request, url, cookie, 0);
      const status = response.status();
      const at = `${spelling} cookie=${cookie}: ${status}`;
      if (status >= 300 && status < 400) {
        // next start answers //pricing with a 308 to /pricing before any rule.
        const location = response.headers().location ?? '';
        expect(location, at).not.toBe('');
        expect(new URL(location, url).pathname, at).not.toMatch(/glass-site/iu);
      } else {
        expect((await response.text()).includes(TWIN_MARKER), at).toBe(false);
      }
    }
  });
}
