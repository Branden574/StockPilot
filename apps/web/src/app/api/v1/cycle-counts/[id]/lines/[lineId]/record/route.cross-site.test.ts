// @vitest-environment node
// Node, not a DOM: a browser-like Request drops Origin and Sec-Fetch-*, which
// the route receives exactly as the browser sent them.
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';

/**
 * Security invariant (docket S14, INV-E5), end to end on the route the finding
 * named: POST /api/v1/cycle-counts/[id]/lines/[lineId]/record, through Next's
 * REAL App Route module (src/test/next-route-harness.ts), the REAL route, the
 * REAL withApiContext and the REAL cross-site rule. Only Supabase, the rate
 * limiter and the counting service are stubbed.
 *
 * The record route has no check of its own: before withApiContext refused a
 * cross-site cookie write, a page on a sibling subdomain could make a signed-in
 * counter's browser record any count it chose on any line that counter could
 * reach. Now the route gives that post its signed-out answer (401
 * unauthenticated), before the session is read and before anything is
 * recorded. Its own page's post, the phone's Bearer post and a client that
 * sends neither header are unchanged.
 */

const h = vi.hoisted(() => ({
  client: null as unknown,
  calls: [] as string[],
  recordCount: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/services/cycle-counts', () => ({
  CycleCountsService: vi.fn(function () {
    return { recordCount: h.recordCount };
  }),
}));

import * as route from './route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const CC = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const APP = 'https://app.test';
const COOKIE = 'sb-example-auth-token=abc';

function fakeSupabase() {
  return {
    rpc: async (name: string) => {
      h.calls.push(`rpc:${name}`);
      return {
        data: {
          user_id: USER,
          profile: {
            id: USER,
            email: 'counter@example.com',
            full_name: null,
            avatar_url: null,
            default_organization_id: ORG,
            disabled_at: null,
          },
          memberships: [
            {
              organization_id: ORG,
              role: 'staff',
              organization: {
                id: ORG,
                name: 'Org',
                logo_url: null,
                terminology: null,
                mfa_policy: 'optional',
                timezone: null,
                nav_overrides: null,
                dashboard_layout: null,
                order_status_config: null,
                all_modules_comp: false,
              },
              role_overrides: [],
              user_overrides: [],
              enabled_modules: ['cycle_counts'],
            },
          ],
        },
        error: null,
      };
    },
    from: (name: string) => {
      throw new Error(`no table read expected: ${name}`);
    },
    auth: {
      getUser: async (jwt?: string) => {
        h.calls.push(jwt ? 'auth:getUser(bearer)' : 'auth:getUser(cookie)');
        return { data: { user: { id: USER, factors: [] } }, error: null };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' } }) },
    },
  };
}

function post(headers: Record<string, string>) {
  return runRouteThroughNext(
    route,
    new Request(`${APP}/api/v1/cycle-counts/${CC}/lines/${LINE}/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ countedQuantity: 7 }),
    }),
    {
      page: '/api/v1/cycle-counts/[id]/lines/[lineId]/record/route',
      params: { id: CC, lineId: LINE },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.calls = [];
  h.client = fakeSupabase();
  h.recordCount = vi.fn(async () => undefined);
});

describe('POST .../record: a cookie write from another origin gets the signed-out answer', () => {
  it.each([
    ['a page on a sibling subdomain', { 'sec-fetch-site': 'same-site', origin: 'https://evil.app.test' }],
    ['a page on another site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['a browser without Sec-Fetch-Site, from another host', { origin: 'https://evil.app.test' }],
  ])('%s: 401, no session read, nothing recorded', async (_name, headers) => {
    const res = await post({ cookie: COOKIE, ...headers });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthenticated' });
    expect(h.calls).toEqual([]);
    expect(h.recordCount).not.toHaveBeenCalled();
  });
});

describe('POST .../record: what still records', () => {
  it("the web app's own post (same origin, the cookie session)", async () => {
    const res = await post({ cookie: COOKIE, 'sec-fetch-site': 'same-origin', origin: APP });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(h.recordCount).toHaveBeenCalledWith(
      expect.objectContaining({ cycleCountId: CC, lineId: LINE, countedQuantity: 7 }),
    );
  });

  it("the phone's post (Bearer), whatever Origin and Sec-Fetch-Site say", async () => {
    const res = await post({
      authorization: 'Bearer h.e30.sig',
      'x-organization-id': ORG,
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]).toBe('auth:getUser(bearer)');
    expect(h.recordCount).toHaveBeenCalledTimes(1);
  });

  it('a client that sends neither header (not a browser a page could drive)', async () => {
    const res = await post({ cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(h.recordCount).toHaveBeenCalledTimes(1);
  });
});
