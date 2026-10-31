// @vitest-environment node
// Node, not a DOM: a browser-like Request drops Origin and Sec-Fetch-*, which a
// route handler receives exactly as the browser sent them.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S14, INV-E5): withApiContext's cookie path refuses
 * a write that a browser did not send from a page of this origin.
 *
 * The session cookies are SameSite=Lax, so a page on a sibling subdomain can
 * make a signed-in member's browser post to any /api route with the cookie
 * attached, and a route handler gets no Origin check from the framework. Every
 * route that builds its context here answers a null context as it answers a
 * signed-out caller (a 401, or its own one answer), so returning null before
 * the session is read IS the refusal, with no route change.
 *
 * Driven through the REAL withApiContext with one fake Supabase client: the
 * refusal must come before the session is read (no getUser, no context RPC),
 * and it covers a cookie write with neither Origin nor Sec-Fetch-Site (fail
 * closed: every supported browser sends Origin on a write). A same-origin
 * write still resolves, a Bearer caller (the phone) is never judged, and a GET
 * is never judged (a link from another site is a GET the browser sends with
 * the cookie).
 */

const refs = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));

import { withApiContext } from './api-context';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const APP = 'https://app.test';
const COOKIE = 'sb-example-auth-token=abc';

const calls: string[] = [];

function makeClient() {
  return {
    rpc: async (name: string) => {
      calls.push(`rpc:${name}`);
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
      calls.push(`table:${name}`);
      throw new Error(`no table read expected: ${name}`);
    },
    auth: {
      getUser: async (jwt?: string) => {
        calls.push(jwt ? 'auth:getUser(bearer)' : 'auth:getUser(cookie)');
        return { data: { user: { id: USER, factors: [] } }, error: null };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1' } }) },
    },
  };
}

function cookieRequest(headers: Record<string, string>, method = 'POST') {
  return new Request(`${APP}/api/v1/cycle-counts/x/lines/y/record`, {
    method,
    headers: { cookie: COOKIE, ...headers },
  });
}

const SIBLING = { 'sec-fetch-site': 'same-site', origin: 'https://evil.app.test' };
const OTHER_SITE = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', origin: APP };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  delete process.env.REQUEST_CONTEXT_RPC;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  refs.client = makeClient();
});

describe('withApiContext: a cookie write from another origin is refused before the session is read', () => {
  it.each([
    ['a sibling subdomain (same site)', SIBLING],
    ['another site', OTHER_SITE],
    ['an Origin alone, from another host (no Sec-Fetch-Site)', { origin: 'https://evil.example' }],
    ['Sec-Fetch-Site alone, cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['an opaque origin', { origin: 'null' }],
    ['neither Origin nor Sec-Fetch-Site (a client, proxy or extension stripped both)', {}],
  ])('%s: null, and no session or context is read', async (_name, headers) => {
    expect(await withApiContext(cookieRequest(headers))).toBeNull();
    expect(calls).toEqual([]);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s from a sibling subdomain: null',
    async (method) => {
      expect(await withApiContext(cookieRequest(SIBLING, method))).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'a cookie %s with neither header: null',
    async (method) => {
      expect(await withApiContext(cookieRequest({}, method))).toBeNull();
      expect(calls).toEqual([]);
    },
  );

  it('a non-Bearer Authorization header is not a bearer: the cookie rule applies', async () => {
    expect(
      await withApiContext(cookieRequest({ ...OTHER_SITE, authorization: 'Basic dXNlcjpwYXNz' })),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it('logs the refusal with the path, the header verdicts and the origin host only', async () => {
    const req = new Request(`${APP}/api/v1/things?token=secret-value`, {
      method: 'POST',
      headers: { cookie: COOKIE, ...SIBLING },
    });
    expect(await withApiContext(req)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('/api/v1/things');
    expect(logged).toContain('same-site');
    expect(logged).toContain('evil.app.test');
    // Never the query, the cookie or the token in it.
    expect(logged).not.toContain('secret-value');
    expect(logged).not.toContain('auth-token');
  });

  it('logs a refused header-less cookie write, with both headers recorded as absent', async () => {
    expect(await withApiContext(cookieRequest({}))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      secFetchSite: null,
      originHost: null,
    });
  });

  it('does not log a refused write that carried no session cookie (its answer was null anyway)', async () => {
    const bare = new Request(`${APP}/api/v1/things`, { method: 'POST' });
    expect(await withApiContext(bare)).toBeNull();
    const elsewhere = new Request(`${APP}/api/v1/things`, {
      method: 'POST',
      headers: { cookie: 'theme=dark', ...OTHER_SITE },
    });
    expect(await withApiContext(elsewhere)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('withApiContext: what still resolves', () => {
  it("a same-origin cookie write (the web app's own fetch) resolves the member", async () => {
    const ctx = await withApiContext(cookieRequest(SAME_ORIGIN));
    expect(ctx?.organizationId).toBe(ORG);
    expect(ctx?.userId).toBe(USER);
    expect(calls).toEqual(['auth:getUser(cookie)', 'rpc:get_request_context']);
  });

  it('a cookie write with only Sec-Fetch-Site same-origin, or only a matching Origin, resolves', async () => {
    expect(
      (await withApiContext(cookieRequest({ 'sec-fetch-site': 'same-origin' })))?.organizationId,
    ).toBe(ORG);
    expect((await withApiContext(cookieRequest({ origin: APP })))?.organizationId).toBe(ORG);
  });

  it('a Bearer write with neither header (the phone) is not judged', async () => {
    const req = new Request(`${APP}/api/v1/cycle-counts/x/lines/y/record`, {
      method: 'POST',
      headers: { authorization: 'Bearer h.e30.sig' },
    });
    expect((await withApiContext(req))?.organizationId).toBe(ORG);
    expect(calls[0]).toBe('auth:getUser(bearer)');
  });

  it.each(['GET', 'HEAD'])(
    'a cookie %s with neither header is not a write: it resolves',
    async (method) => {
      expect((await withApiContext(cookieRequest({}, method)))?.organizationId).toBe(ORG);
    },
  );

  it('a Bearer write (the phone) is not judged, whatever Origin and Sec-Fetch-Site say', async () => {
    const req = new Request(`${APP}/api/v1/cycle-counts/x/lines/y/record`, {
      method: 'POST',
      headers: { authorization: 'Bearer h.e30.sig', ...OTHER_SITE },
    });
    expect((await withApiContext(req))?.organizationId).toBe(ORG);
    expect(calls[0]).toBe('auth:getUser(bearer)');
  });

  it.each(['GET', 'HEAD'])(
    'a cookie %s from another site is not a write: it resolves',
    async (method) => {
      expect((await withApiContext(cookieRequest(OTHER_SITE, method)))?.organizationId).toBe(ORG);
    },
  );

  it('a POST built from a same-origin request (the sign route builds one) resolves', async () => {
    const incoming = cookieRequest(SAME_ORIGIN);
    const headers = new Headers(incoming.headers);
    headers.set('x-organization-id', ORG);
    const ctx = await withApiContext(
      new Request(incoming.url, { method: incoming.method, headers }),
    );
    expect(ctx?.organizationId).toBe(ORG);
  });

  it('no request at all still answers null, as before', async () => {
    expect(await withApiContext()).toBeNull();
    expect(calls).toEqual([]);
  });
});
