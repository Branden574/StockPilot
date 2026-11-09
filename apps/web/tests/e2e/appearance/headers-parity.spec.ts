import { existsSync, readFileSync } from 'node:fs';

import { expect, request as playwrightRequest, test } from '@playwright/test';

import { MARKETING_PATHS, rolloutOf } from './site-look';
import { requireEnv, stage5Role } from './stage5a-lib';
import { diffHeaderLines, normaliseHeaders, SECURITY_HEADERS } from './stage5a-headers';

/**
 * PROVES plan 8.5 "headers and caching": the CSP and the security and
 * caching headers are byte-identical before and after. Every route below is
 * asked of two lab servers with the same cookies: STAGE5_BASE_URL_B (classic
 * at the merge base B, 7dacbd7aa) and PLAYWRIGHT_BASE_URL (the branch, in
 * the run's rollout), redirects not followed, and the headers compared
 * after stage5a-headers.ts normalises what changes on every answer (unit
 * test src/test/stage5a-headers.test.ts: the CSP nonce, Date, ETag, request
 * ids, a Set-Cookie's value and expiry, hashed static paths in Link).
 *
 *  - with sp_style=classic (both servers serve the classic page): EVERY
 *    header, byte for byte after normalising;
 *  - with no Design cookie: the security and caching headers
 *    (SECURITY_HEADERS) byte for byte; every header too where the branch's
 *    rollout serves classic to a visitor without a cookie (off, opt-in). In
 *    the default rollout a marketing path then serves its glass twin, whose
 *    other headers are listed as an annotation for the reviewer.
 * Signed out in the signed-out run; signed in (the role's storageState: one
 * lab database, so the same session works on both servers) in each role's
 * run.
 *
 * Lab command (needs both servers running):
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:<branch port> STAGE5_BASE_URL_B=http://127.0.0.1:<B port> \
 *     STAGE5_ROLE=<role> pnpm exec playwright test -c playwright.stage5.config.ts tests/e2e/appearance/headers-parity.spec.ts
 */

const SIGNED_OUT = [
  ...MARKETING_PATHS,
  '/signin',
  '/signup',
  '/reset',
  '/robots.txt',
  '/sitemap.xml',
];
const SIGNED_IN = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/books',
  '/dashboard/orders',
  '/dashboard/orders/new',
  '/dashboard/reports',
  '/dashboard/reports/book-order-totals',
  '/dashboard/team',
  '/dashboard/notifications',
  '/dashboard/settings/profile',
  '/dashboard/purchase-orders',
  '/dashboard/cycle-counts',
  '/dashboard/returns',
  '/platform',
  '/portal',
  '/signin',
];

interface Profile {
  cookies: Array<{ name: string } & Record<string, unknown>>;
  origins: unknown[];
}

/**
 * The project's profile (none for the signed-out run) with the Design cookie
 * set to `cookie` for `baseURL`'s host, or removed (null). Cookies ignore the
 * port, so one profile serves both servers.
 */
function profile(baseURL: string, cookie: string | null): Profile {
  const state = test.info().project.use.storageState;
  const base: Profile =
    typeof state === 'string' && existsSync(state)
      ? (JSON.parse(readFileSync(state, 'utf8')) as Profile)
      : { cookies: [], origins: [] };
  const cookies = base.cookies.filter((c) => c.name !== 'sp_style');
  if (cookie !== null) {
    cookies.push({
      name: 'sp_style',
      value: cookie,
      domain: new URL(baseURL).hostname,
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    });
  }
  return { cookies, origins: [] };
}

async function headersOf(baseURL: string, path: string, cookie: string | null) {
  const context = await playwrightRequest.newContext({
    baseURL,
    storageState: profile(baseURL, cookie) as never,
  });
  const response = await context.get(path, { maxRedirects: 0 });
  const out = { status: response.status(), headers: response.headers() };
  await context.dispose();
  return out;
}

const signedIn = () => stage5Role() !== null;

for (const cookie of ['classic', null] as const) {
  test.describe(`with ${cookie === null ? 'no Design cookie' : 'sp_style=classic'}`, () => {
    for (const path of [...new Set([...SIGNED_OUT, ...SIGNED_IN])]) {
      test(`${path}: the same headers on B and on the branch`, async ({ baseURL, request }) => {
        const inList = signedIn() ? SIGNED_IN.includes(path) : SIGNED_OUT.includes(path);
        test.skip(!inList, `${path} is not in this run’s list.`);
        const { STAGE5_BASE_URL_B: base } = requireEnv('STAGE5_BASE_URL_B');
        const before = await headersOf(base, path, cookie);
        const after = await headersOf(baseURL!, path, cookie);
        expect(after.status, `${path}: the status`).toBe(before.status);

        const rollout = rolloutOf(
          await (await request.get('/privacy', { headers: { cookie: 'sp_style=classic' } })).text(),
        );
        const sameClassicPage = cookie === 'classic' || rollout !== 'default';
        const security = diffHeaderLines(
          normaliseHeaders(before.headers, SECURITY_HEADERS),
          normaliseHeaders(after.headers, SECURITY_HEADERS),
        );
        expect(security, `${path}: the security and caching headers`).toEqual([]);
        const all = diffHeaderLines(
          normaliseHeaders(before.headers),
          normaliseHeaders(after.headers),
        );
        if (sameClassicPage) {
          expect(all, `${path}: every header`).toEqual([]);
        } else if (all.length) {
          test.info().annotations.push({
            type: 'glass twin headers (reviewed, not failed)',
            description: `${path}: ${all.join(' | ')}`,
          });
        }
      });
    }
  });
}
