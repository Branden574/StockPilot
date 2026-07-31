import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account-disable enforcement guard, proved at ALL THREE authenticated
 * entry points this app has:
 *
 *   1. loadSessionAndContext (lib/auth/session.ts)      — RSC pages + Server Actions
 *   2. withApiContext        (lib/auth/api-context.ts)  — cookie API + Bearer API
 *   3. resolvePortalContext  (server/services/portal.ts) — the B2B customer portal
 *
 * (3) is the one the original plan missed. It resolves identity itself
 * (createClient + auth.getUser) and then reads with createAdminClient (RLS
 * bypassed), so it inherits nothing from (1) or (2). Every auth user has a
 * user_profiles row (0001_init's on_auth_user_created trigger) and /portal is
 * in the proxy matcher, so a disabled portal user is a real, reachable case.
 *
 * The fakes below are PostgREST-shaped (chainable, awaitable, maybeSingle-able)
 * so the real production code paths run end to end — nothing here stubs the
 * guard itself.
 */

const refs = vi.hoisted(() => ({
  /** The user-authed client both session.ts and api-context.ts build. */
  client: null as unknown,
  /** The service-role client portal.ts builds. */
  admin: null as unknown,
  /** What next/headers() returns for the RSC path. */
  headers: new Headers(),
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: (...a: unknown[]) => refs.reportError(...(a as [])),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/auth/effective-permissions', () => ({
  loadEffectivePermissions: async () => new Set<string>(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => refs.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => refs.client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => refs.admin }));
vi.mock('next/headers', () => ({ headers: async () => refs.headers }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
// Portal module-level imports that are irrelevant to identity resolution.
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));

import { ACCOUNT_DISABLED_PATH } from '@stockpilot/core';

import { accountIsDisabled, loadAccountStatus } from './account-status';
import { withApiContext } from './api-context';
import { getServerSession, requireOrgContext } from './session';
import { resolvePortalContext } from '@/server/services/portal';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID = '88888888-8888-8888-8888-888888888888';
const CUSTOMER_ID = '77777777-7777-4777-8777-777777777777';
const DISABLED_AT = '2026-07-31T00:00:00.000Z';

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  default_organization_id: string | null;
  disabled_at: string | null;
}

const state: {
  profile: ProfileRow | null;
  profileError: { message: string } | null;
  member: { organization_id: string; role: string } | null;
  memberRows: unknown[];
} = {
  profile: null,
  profileError: null,
  member: null,
  memberRows: [],
};

/** Minimal PostgREST-shaped fake: chainable, awaitable, and maybeSingle-able. */
function table(
  single: unknown,
  list: unknown[] = [],
  error: { message: string } | null = null,
) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.select = self;
  q.eq = self;
  q.is = self;
  q.not = self;
  q.in = self;
  q.limit = self;
  q.order = self;
  q.range = self;
  q.update = self;
  q.maybeSingle = async () => ({ data: error ? null : single, error });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: error ? null : list, error }).then(resolve);
  return q;
}

/** The client the proxy-verified user (cookie or bearer) queries with. */
function userClient() {
  return {
    from: (name: string) => {
      if (name === 'user_profiles') return table(state.profile, [], state.profileError);
      if (name === 'organization_members') return table(state.member, state.memberRows);
      if (name === 'organizations') return table({ mfa_policy: 'optional' });
      if (name === 'organization_modules') return table(null, []);
      return table(null);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
    },
  };
}

/** The service-role client portal.ts reads customers with (RLS bypassed). */
function adminClient() {
  return {
    from: (name: string) => {
      if (name === 'customer_users') {
        return table(null, [
          {
            customer_id: CUSTOMER_ID,
            email: 'buyer@school.example.com',
            accepted_at: '2026-07-01T00:00:00Z',
            invited_at: '2026-06-01T00:00:00Z',
            customer: {
              id: CUSTOMER_ID,
              name: 'Harbor Elementary',
              status: 'active',
              organization_id: ORG_ID,
              price_list_id: null,
            },
          },
        ]);
      }
      if (name === 'organization_modules') {
        return table({ module_id: 'b2b_portal', settings: { pricingMode: 'priced' } });
      }
      if (name === 'organizations') {
        return table({ name: 'L4L North Region', logo_url: null, plan: null, access_tier: 'business' });
      }
      return table(null);
    },
  };
}

function bearerRequest(): Request {
  return new Request('https://app.test/api/v1/items', {
    headers: { authorization: 'Bearer token.abc.def', 'x-organization-id': ORG_ID },
  });
}

function cookieRequest(): Request {
  return new Request('https://app.test/api/items', {
    headers: { cookie: 'sb-example-auth-token=abc' },
  });
}

beforeEach(() => {
  refs.reportError.mockClear();
  state.profile = {
    id: USER_ID,
    email: 'user@example.com',
    full_name: 'Test User',
    avatar_url: null,
    default_organization_id: ORG_ID,
    disabled_at: null,
  };
  state.profileError = null;
  state.member = { organization_id: ORG_ID, role: 'staff' };
  state.memberRows = [
    {
      organization_id: ORG_ID,
      role: 'staff',
      organizations: { id: ORG_ID, name: 'Acme', logo_url: null },
    },
  ];
  refs.client = userClient();
  refs.admin = adminClient();
  refs.headers = new Headers({
    'x-stockpilot-user-id': USER_ID,
    'x-stockpilot-user-email': 'user@example.com',
  });
});

function disableTheAccount() {
  state.profile = { ...(state.profile as ProfileRow), disabled_at: DISABLED_AT };
}

describe('accountIsDisabled', () => {
  it('is active for null and for a missing row', () => {
    expect(accountIsDisabled({ disabled_at: null })).toBe(false);
    expect(accountIsDisabled(null)).toBe(false);
  });

  it('is disabled for any timestamp', () => {
    expect(accountIsDisabled({ disabled_at: DISABLED_AT })).toBe(true);
  });
});

describe('loadAccountStatus', () => {
  it('fails CLOSED on a read error', async () => {
    state.profileError = { message: 'permission denied' };

    expect(await loadAccountStatus(refs.client, USER_ID)).toEqual({ disabled: true });
    expect(refs.reportError).toHaveBeenCalled();
  });

  it('treats an absent row as ACTIVE (onboarding, not a disable)', async () => {
    state.profile = null;

    expect(await loadAccountStatus(refs.client, USER_ID)).toEqual({ disabled: false });
    expect(refs.reportError).not.toHaveBeenCalled();
  });
});

describe('install point 1 — loadSessionAndContext (pages + Server Actions)', () => {
  it('returns a session for an active account', async () => {
    const session = await getServerSession();

    expect(session?.userId).toBe(USER_ID);
    expect(session?.defaultOrganizationId).toBe(ORG_ID);
  });

  it('redirects a disabled account off every RSC page', async () => {
    disableTheAccount();

    await expect(getServerSession()).rejects.toThrow(`NEXT_REDIRECT:${ACCOUNT_DISABLED_PATH}`);
  });

  it('redirects a disabled account out of requireOrgContext (every Server Action)', async () => {
    disableTheAccount();

    await expect(requireOrgContext()).rejects.toThrow(`NEXT_REDIRECT:${ACCOUNT_DISABLED_PATH}`);
  });

  it('still lets an active account through requireOrgContext', async () => {
    const ctx = await requireOrgContext();

    expect(ctx.organizationId).toBe(ORG_ID);
    expect(ctx.role).toBe('staff');
  });
});

describe('install point 2 — withApiContext refuses a disabled account', () => {
  it('BEARER: returns a context for an active account', async () => {
    const ctx = await withApiContext(bearerRequest());

    expect(ctx).not.toBeNull();
    expect(ctx?.organizationId).toBe(ORG_ID);
    expect(ctx?.userId).toBe(USER_ID);
  });

  it('BEARER: returns null for a disabled account even with a valid token and a real membership', async () => {
    disableTheAccount();

    expect(await withApiContext(bearerRequest())).toBeNull();
  });

  it('COOKIE: returns null for a disabled account', async () => {
    disableTheAccount();

    expect(await withApiContext(cookieRequest())).toBeNull();
  });

  it('COOKIE: returns a context for an active account', async () => {
    expect(await withApiContext(cookieRequest())).not.toBeNull();
  });

  it('still returns null when there is no auth at all', async () => {
    expect(await withApiContext(new Request('https://app.test/api/items'))).toBeNull();
  });
});

describe('install point 3 — resolvePortalContext (B2B customer portal)', () => {
  it('returns a portal context for an active account', async () => {
    const ctx = await resolvePortalContext();

    expect(ctx?.userId).toBe(USER_ID);
    expect(ctx?.customerId).toBe(CUSTOMER_ID);
    expect(ctx?.organizationId).toBe(ORG_ID);
  });

  it('returns null for a disabled account — no catalog, no order submission', async () => {
    disableTheAccount();

    expect(await resolvePortalContext()).toBeNull();
  });
});
