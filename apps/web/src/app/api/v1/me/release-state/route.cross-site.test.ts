// @vitest-environment node
// Node, not a DOM: a browser-like Request drops Origin and Sec-Fetch-*, which
// the route receives exactly as the browser sent them.
// FIRST: Next builds its request storages from this global when they load.
import '@/test/next-als';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { runRouteThroughNext } from '@/test/next-route-harness';

/**
 * Security invariant (docket S14, INV-E5), end to end: POST
 * /api/v1/me/release-state through Next's REAL App Route module, the REAL
 * route, the REAL withApiContext and the REAL cross-site rule. Only Supabase
 * and the release-state store are stubbed.
 *
 * This route judged a cross-site post before S14, by Origin alone: it let
 * through a post whose Sec-Fetch-Site said another site but which carried no
 * Origin, a post with neither header, and any post with an Authorization
 * header of any kind. It now uses the shared rule and keeps its own answer
 * (403 forbidden). The web app's own post and the phone's are unchanged.
 */

const h = vi.hoisted(() => ({
  client: null as unknown,
  calls: [] as string[],
  recordReleaseState: null as unknown as Mock<(...args: unknown[]) => Promise<unknown>>,
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
vi.mock('@/server/services/releases', () => ({
  recordReleaseState: (...args: unknown[]) => h.recordReleaseState(...args),
}));

import * as route from './route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
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
            email: 'member@example.com',
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
              enabled_modules: [],
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
    new Request(`${APP}/api/v1/me/release-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ action: 'read_all' }),
    }),
    { page: '/api/v1/me/release-state/route' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.calls = [];
  h.client = fakeSupabase();
  h.recordReleaseState = vi.fn(async () => ({ ok: true, recorded: 3 }));
});

describe('POST /api/v1/me/release-state: a cookie write from another origin is refused', () => {
  it.each([
    [
      'a page on a sibling subdomain',
      { 'sec-fetch-site': 'same-site', origin: 'https://evil.app.test' },
    ],
    ['a page on another site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['Sec-Fetch-Site cross-site with no Origin', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
    ['an opaque origin', { origin: 'null' }],
    [
      'a Basic Authorization header from another site',
      { authorization: 'Basic dXNlcjpwYXNz', origin: 'https://evil.example' },
    ],
    [
      'neither Origin nor Sec-Fetch-Site (fail closed: every supported browser sends Origin on a write)',
      {},
    ],
  ])('%s: 403, no session read, nothing stamped', async (_name, headers) => {
    const res = await post({ cookie: COOKIE, ...headers });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
    expect(h.calls).toEqual([]);
    expect(h.recordReleaseState).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/me/release-state: what still records', () => {
  it("the web app's own post (same origin, the cookie session)", async () => {
    const res = await post({ cookie: COOKIE, 'sec-fetch-site': 'same-origin', origin: APP });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, recorded: 3 });
    expect(h.calls).toEqual(['auth:getUser(cookie)', 'rpc:get_request_context']);
    expect(h.recordReleaseState).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, organizationId: ORG }),
      { action: 'read_all' },
    );
  });

  it("the phone's post (Bearer), whatever Origin and Sec-Fetch-Site say", async () => {
    const res = await post({
      authorization: 'Bearer h.e30.sig',
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]).toBe('auth:getUser(bearer)');
  });

  it("the phone's post (Bearer) with neither header", async () => {
    const res = await post({ authorization: 'Bearer h.e30.sig' });
    expect(res.status).toBe(200);
    expect(h.recordReleaseState).toHaveBeenCalledTimes(1);
  });
});
