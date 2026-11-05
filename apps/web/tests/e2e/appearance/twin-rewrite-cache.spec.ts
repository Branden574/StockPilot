import { expect, test } from '@playwright/test';

import {
  buildRollout,
  fetchAs,
  MARKETING_PATHS,
  TWIN_MARKER,
  twinPath,
  twinSelected,
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
 *    the requests interleave.
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * components/theme/appearance-flag.test.ts (the rules per rollout).
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
