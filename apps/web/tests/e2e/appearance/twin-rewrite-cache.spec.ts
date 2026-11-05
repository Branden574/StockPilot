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
 *    never forces glass on anyone;
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
  for (const path of MARKETING_PATHS) {
    for (const cookie of COOKIES) {
      const response = await fetchAs(request, twinPath(path), cookie, 0);
      expect(response.status(), `${twinPath(path)} cookie=${cookie}`).toBe(307);
      const location = response.headers().location ?? '';
      expect(new URL(location, baseURL).pathname).toBe(path);
    }
  }
  // Below a twin too (nothing is served under /glass-site at all).
  const deep = await fetchAs(request, '/glass-site/contact/anything', null, 0);
  expect(deep.status()).toBe(307);
  expect(new URL(deep.headers().location ?? '', baseURL).pathname).toBe('/contact/anything');
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
