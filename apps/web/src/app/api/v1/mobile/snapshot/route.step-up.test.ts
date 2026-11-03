import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S43a): the phone's snapshot, end to end through
 * the REAL withApiContext, refuses an account with a verified authenticator
 * factor whose token is still aal1.
 *
 * This is the read the phone made behind its own code screen (the filed N-1):
 * items with SKUs, barcodes, quantities and costs, warehouses, open purchase
 * orders, counts, kits and permissions, for a password alone. Now the answer
 * is the route's own 401 and NOTHING is read: no context RPC and no table,
 * because the refusal comes right after the identity check. A 401 is what
 * phones already installed retry, keeping their cache and queued work.
 */

const refs = vi.hoisted(() => ({
  calls: [] as string[],
  factors: [] as Array<{ status: string }>,
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 29, resetAt: Date.now() })),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => recordingClient() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => recordingClient() }));

import { GET } from './route';

const USER = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';

/** Every query answers empty: the point is whether one is made at all. */
function emptyBuilder(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null, count: 0, status: 200 }).then(resolve, reject);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return async () => ({ data: null, error: null });
        }
        return () => proxy;
      },
    },
  );
  refs.calls.push(`from:${table}`);
  return proxy;
}

function recordingClient() {
  return {
    from: (table: string) => emptyBuilder(table),
    rpc: async (name: string) => {
      refs.calls.push(`rpc:${name}`);
      if (name !== 'get_request_context') return { data: [], error: null };
      return {
        data: {
          user_id: USER,
          profile: {
            id: USER,
            email: 'person@example.test',
            full_name: null,
            avatar_url: null,
            default_organization_id: ORG,
            disabled_at: null,
          },
          memberships: [
            {
              organization_id: ORG,
              role: 'owner',
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
                order_catalog_last_hide_at: null,
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
    auth: {
      getUser: async () => {
        refs.calls.push('auth:getUser');
        return { data: { user: { id: USER, factors: refs.factors } }, error: null };
      },
    },
  };
}

function token(aal: 'aal1' | 'aal2'): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: USER, aal })}.sig`;
}

function pull(aal: 'aal1' | 'aal2'): NextRequest {
  return new NextRequest('https://app.test/api/v1/mobile/snapshot', {
    headers: { authorization: `Bearer ${token(aal)}`, 'x-organization-id': ORG },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  refs.calls = [];
  refs.factors = [];
});

describe('GET /api/v1/mobile/snapshot and the authenticator code', () => {
  it('an enrolled phone whose token is aal1 gets 401, and nothing is read', async () => {
    refs.factors = [{ status: 'verified' }];

    const res = await GET(pull('aal1'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(refs.calls).toEqual(['auth:getUser']);
  });

  it('the same phone with its code (aal2) is served, so the refusal is not a lockout', async () => {
    refs.factors = [{ status: 'verified' }];

    const res = await GET(pull('aal2'));

    expect(res.status).toBe(200);
    expect(refs.calls).toContain('rpc:get_request_context');
    expect(refs.calls.some((c) => c.startsWith('from:'))).toBe(true);
  });

  it('a phone with no factor is served at aal1, as before', async () => {
    const res = await GET(pull('aal1'));
    expect(res.status).toBe(200);
  });
});
