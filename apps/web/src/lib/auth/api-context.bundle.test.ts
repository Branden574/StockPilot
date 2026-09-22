import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The API context in ONE round trip, and the proof it decides exactly what the
 * seven-to-nine reads decided.
 *
 * `/api/**` is outside the proxy matcher, so the page path's bundle never
 * applied here and every API call re-read membership, account status, MFA
 * policy, modules and permissions separately. ONE fake Supabase client serves
 * BOTH paths below, so "same answer" is a comparison of two code paths over the
 * same rows rather than over two fixtures.
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

import { effectivePermissions, type Permission, type PermissionOverride } from '@stockpilot/core';

import { NON_CORE_MODULE_IDS } from '@/lib/modules/effective-modules';

import { withApiContext } from './api-context';

const USER = '99999999-9999-9999-9999-999999999999';
const ORG_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const ORG_B = 'bbbbbbbb-2222-2222-2222-222222222222';

interface Membership {
  organization_id: string;
  role: string;
  mfa_policy?: 'optional' | 'admins_required' | 'all_required';
  all_modules_comp?: boolean;
  hideOrganization?: boolean;
  enabled_modules?: string[];
  role_overrides?: Array<{ permission: string; granted: boolean }>;
  user_overrides?: Array<{ permission: string; granted: boolean }>;
}

const world = {
  profile: { default_organization_id: null as string | null, disabled_at: null as string | null },
  hideProfile: false,
  /** Legacy path only: the `organizations` row reads back as absent. */
  hideOrganization: false,
  memberships: [] as Membership[],
  /** null = the function answers; otherwise the shape the RPC returns instead. */
  rpc: 'answer' as 'answer' | 'error' | 'throw' | 'junk' | 'missing',
  /** A FAILED read of `organizations` — postgrest resolves these, it does not throw. */
  orgReadError: null as { code: string; message: string } | null,
  aal: 'aal2' as 'aal1' | 'aal2',
  verifiedFactor: false,
  calls: [] as string[],
};

function bundleJson() {
  return {
    user_id: USER,
    profile: world.hideProfile
      ? null
      : {
          id: USER,
          email: 'user@example.com',
          full_name: null,
          avatar_url: null,
          default_organization_id: world.profile.default_organization_id,
          disabled_at: world.profile.disabled_at,
        },
    memberships: world.memberships.map((m) => ({
      organization_id: m.organization_id,
      role: m.role,
      organization: m.hideOrganization
        ? null
        : {
            id: m.organization_id,
            name: 'Org',
            logo_url: null,
            terminology: null,
            mfa_policy: m.mfa_policy ?? 'optional',
            timezone: null,
            nav_overrides: null,
            dashboard_layout: null,
            order_status_config: null,
            all_modules_comp: m.all_modules_comp ?? false,
          },
      role_overrides: m.role_overrides ?? [],
      user_overrides: m.user_overrides ?? [],
      enabled_modules: m.enabled_modules ?? [],
    })),
  };
}

/** A query builder that records the table it was asked for. */
function table(single: unknown, list: unknown[] = [], error: unknown = null) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const k of ['select', 'eq', 'is', 'not', 'in', 'limit', 'order']) q[k] = self;
  q.maybeSingle = async () => ({ data: error ? null : single, error });
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: error ? null : list, error }).then(resolve);
  return q;
}

function makeClient() {
  const active = () =>
    world.memberships.find((m) => m.organization_id === world.profile.default_organization_id) ??
    world.memberships[0];
  return {
    rpc: async (name: string) => {
      world.calls.push(`rpc:${name}`);
      if (world.rpc === 'missing') return { data: null, error: { code: '42883' } };
      if (world.rpc === 'error') return { data: null, error: { code: '' } };
      if (world.rpc === 'throw') throw new Error('socket closed');
      if (world.rpc === 'junk')
        return { data: { user_id: USER, memberships: 'nope' }, error: null };
      return { data: bundleJson(), error: null };
    },
    from: (name: string) => {
      world.calls.push(`table:${name}`);
      const m = active();
      if (name === 'user_profiles')
        return table(
          world.hideProfile
            ? null
            : {
                id: USER,
                email: 'user@example.com',
                default_organization_id: world.profile.default_organization_id,
                disabled_at: world.profile.disabled_at,
              },
        );
      if (name === 'organization_members')
        return table(m ? { organization_id: m.organization_id, role: m.role } : null);
      if (name === 'organizations')
        return table(
          world.hideOrganization
            ? null
            : {
                mfa_policy: m?.mfa_policy ?? 'optional',
                all_modules_comp: m?.all_modules_comp ?? false,
              },
          [],
          world.orgReadError,
        );
      if (name === 'organization_modules')
        return table(
          null,
          (m?.enabled_modules ?? []).map((module_id) => ({ module_id })),
        );
      if (name === 'role_permission_overrides') return table(null, m?.role_overrides ?? []);
      if (name === 'user_permission_overrides') return table(null, m?.user_overrides ?? []);
      return table(null, []);
    },
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: USER,
            factors: world.verifiedFactor ? [{ status: 'verified' }] : [],
          },
        },
        error: null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          world.calls.push('auth:aal');
          return { data: { currentLevel: world.aal } };
        },
      },
    },
  };
}

/** A token whose unverified `aal` claim the bearer path reads. */
const jwt = (aal: string) =>
  `h.${Buffer.from(JSON.stringify({ aal }), 'utf8').toString('base64url')}.sig`;

const cookie = (headers: Record<string, string> = {}) =>
  new Request('https://app.test/api/v1/me/releases', {
    headers: { cookie: 'sb-example-auth-token=abc', ...headers },
  });
const bearer = (headers: Record<string, string> = {}) =>
  new Request('https://app.test/api/v1/me/releases', {
    headers: { authorization: `Bearer ${jwt(world.aal)}`, ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.REQUEST_CONTEXT_RPC;
  world.profile = { default_organization_id: null, disabled_at: null };
  world.hideProfile = false;
  world.hideOrganization = false;
  world.memberships = [{ organization_id: ORG_A, role: 'staff' }];
  world.rpc = 'answer';
  world.orgReadError = null;
  world.aal = 'aal2';
  world.verifiedFactor = false;
  world.calls = [];
  refs.client = makeClient();
});

/** The same request resolved by the fast path and then by the legacy reads. */
async function both(req: Request) {
  world.calls = [];
  const fast = await withApiContext(req);
  const fastCalls = [...world.calls];
  process.env.REQUEST_CONTEXT_RPC = 'off';
  world.calls = [];
  const legacy = await withApiContext(req);
  const legacyCalls = [...world.calls];
  delete process.env.REQUEST_CONTEXT_RPC;
  return { fast, legacy, fastCalls, legacyCalls };
}

const shape = (ctx: Awaited<ReturnType<typeof withApiContext>>) =>
  ctx && {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    role: ctx.role,
    permissions: [...(ctx.permissions ?? [])].sort(),
    enabledModules: [...ctx.enabledModules].sort(),
    mfaRequired: ctx.mfaRequired,
    mfaSatisfied: ctx.mfaSatisfied,
    mfaEnrolled: ctx.mfaEnrolled,
  };

/**
 * Overrides that REALLY change a manager's set, so a fast path that dropped
 * them could not pass. `members:invite` is not a manager permission and is
 * granted here; `items:create` is one and is revoked.
 */
const GRANTED_NOT_HELD: Permission = 'members:invite';
const REVOKED_HELD: Permission = 'items:create';
const REAL_OVERRIDES: {
  role_overrides: PermissionOverride[];
  user_overrides: PermissionOverride[];
} = {
  role_overrides: [{ permission: GRANTED_NOT_HELD, granted: true }],
  user_overrides: [{ permission: REVOKED_HELD, granted: false }],
};

describe('the API context resolves in one round trip', () => {
  it('reads no tables at all, where the legacy path read eight', async () => {
    const { fast, fastCalls, legacyCalls } = await both(cookie());
    expect(fast).not.toBeNull();
    expect(fastCalls).toEqual(['rpc:get_request_context']);
    // An exact count, not a floor: if the legacy path ever got cheaper, the
    // claim this change rests on would need re-measuring rather than quietly
    // still passing.
    expect(legacyCalls).toEqual([
      'table:user_profiles', // which organization (the default)
      'table:user_profiles', // account status
      'table:organization_members', // that membership
      'table:organizations', // the MFA policy
      'table:organization_modules', // the enabled modules...
      'table:organizations', // ...and the comp flag that widens them
      'table:role_permission_overrides',
      'table:user_permission_overrides',
    ]);
  });

  it.each([
    ['cookie', cookie],
    ['bearer', bearer],
  ])('gives the same context the separate reads gave (%s)', async (_kind, make) => {
    world.memberships = [
      {
        organization_id: ORG_A,
        role: 'manager',
        enabled_modules: ['maintenance'],
        ...REAL_OVERRIDES,
      },
    ];
    const { fast, legacy, fastCalls } = await both(make());
    expect(shape(fast)).toEqual(shape(legacy));
    expect(fast?.role).toBe('manager');
    expect(fast?.userId).toBe(USER);
    expect(fastCalls.filter((c) => c.startsWith('table:'))).toEqual([]);
    // The overrides BIT, both ways round: without them the sets differ.
    expect(fast?.permissions?.has(GRANTED_NOT_HELD)).toBe(true);
    expect(fast?.permissions?.has(REVOKED_HELD)).toBe(false);
    const plain = effectivePermissions('manager');
    expect(plain.has(GRANTED_NOT_HELD)).toBe(false);
    expect(plain.has(REVOKED_HELD)).toBe(true);
    expect(fast?.permissions).toEqual(
      effectivePermissions('manager', REAL_OVERRIDES.role_overrides, REAL_OVERRIDES.user_overrides),
    );
  });

  it.each([
    ['cookie', cookie],
    ['bearer', bearer],
  ])('honours the comp flag the same way (%s)', async (_kind, make) => {
    world.memberships = [
      { organization_id: ORG_A, role: 'admin', all_modules_comp: true, enabled_modules: [] },
    ];
    const { fast, legacy } = await both(make());
    expect(shape(fast)).toEqual(shape(legacy));
    // Comped means EVERY non-core module, from no explicit rows at all.
    expect(fast!.enabledModules.size).toBe(NON_CORE_MODULE_IDS.length);
  });

  it.each([
    ['cookie', cookie],
    ['bearer', bearer],
  ])('carries the explicitly enabled modules and nothing else (%s)', async (_kind, make) => {
    world.memberships = [
      { organization_id: ORG_A, role: 'staff', enabled_modules: ['maintenance'] },
    ];
    const { fast, legacy } = await both(make());
    expect(shape(fast)).toEqual(shape(legacy));
    expect([...fast!.enabledModules]).toContain('maintenance');
  });

  it('never lets an override widen an owner', async () => {
    world.memberships = [
      {
        organization_id: ORG_A,
        role: 'owner',
        role_overrides: [{ permission: 'items:delete', granted: false }],
      },
    ];
    const { fast, legacy } = await both(cookie());
    expect(shape(fast)).toEqual(shape(legacy));
    // The guarantee itself lives in core's effectivePermissions (owner returns
    // the full set before overrides are read), so this holds however the two
    // call sites spell it. It is asserted HERE because this path is where an
    // owner's overrides would arrive if anyone ever changed that.
    expect(fast?.permissions).toEqual(effectivePermissions('owner'));
    expect(fast?.permissions?.has('items:delete')).toBe(true);
  });
});

describe('which organization, and whether to answer at all', () => {
  it('prefers the default organization, then the oldest membership', async () => {
    world.memberships = [
      { organization_id: ORG_A, role: 'staff' },
      { organization_id: ORG_B, role: 'admin' },
    ];
    expect((await withApiContext(cookie()))?.organizationId).toBe(ORG_A);
    world.profile.default_organization_id = ORG_B;
    expect((await withApiContext(cookie()))?.organizationId).toBe(ORG_B);
  });

  it('honours X-Organization-Id only for an organization the caller belongs to', async () => {
    world.memberships = [
      { organization_id: ORG_A, role: 'staff' },
      { organization_id: ORG_B, role: 'admin' },
    ];
    const mine = await withApiContext(cookie({ 'x-organization-id': ORG_B }));
    expect(mine?.organizationId).toBe(ORG_B);
    expect(mine?.role).toBe('admin');
    // Not a member: refused outright, never silently scoped to another org.
    const theirs = await withApiContext(
      cookie({ 'x-organization-id': 'cccccccc-3333-3333-3333-333333333333' }),
    );
    expect(theirs).toBeNull();
  });

  it('matches X-Organization-Id the way Postgres did: a uuid, not a case-sensitive string', async () => {
    // The legacy path compared this in the database, where uuid equality
    // ignores case. iOS hands out UPPERCASE uuid strings by default, so a
    // case-sensitive match here would 401 a caller the old path served.
    world.memberships = [
      { organization_id: ORG_A, role: 'staff' },
      { organization_id: ORG_B, role: 'admin' },
    ];
    const upper = await withApiContext(cookie({ 'x-organization-id': ORG_B.toUpperCase() }));
    expect(upper?.organizationId).toBe(ORG_B);
    expect(upper?.role).toBe('admin');
    // And it is still an exact uuid match, not a loose one.
    expect(await withApiContext(cookie({ 'x-organization-id': ORG_B.slice(0, -1) }))).toBeNull();
  });

  it('refuses a disabled account', async () => {
    world.profile.disabled_at = '2026-09-01T00:00:00Z';
    const { fast, legacy, fastCalls } = await both(cookie());
    expect(fast).toBeNull();
    expect(legacy).toBeNull();
    expect(fastCalls).toEqual(['rpc:get_request_context']);
  });

  it('refuses a user with no accepted membership', async () => {
    world.memberships = [];
    expect(await withApiContext(cookie())).toBeNull();
  });
});

describe('it falls back rather than guess', () => {
  const fallsBack = async () => {
    world.calls = [];
    const ctx = await withApiContext(cookie());
    return { ctx, readTables: world.calls.some((c) => c.startsWith('table:')) };
  };

  it('when the function is missing, errors, throws or answers something unexpected', async () => {
    for (const mode of ['missing', 'error', 'throw', 'junk'] as const) {
      world.rpc = mode;
      const { ctx, readTables } = await fallsBack();
      expect(ctx, mode).not.toBeNull();
      expect(readTables, mode).toBe(true);
    }
  });

  it('when the caller cannot read their own profile — "unreadable" must not become "active"', async () => {
    world.hideProfile = true;
    const { readTables } = await fallsBack();
    expect(readTables).toBe(true);
    // DELIBERATELY, not by tripping over a null further down: an accidental
    // exception falls back too, but it logs a fault for something that is a
    // legitimate answer, and it would stop being a fallback the moment the
    // line that throws moves.
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain('threw');
  });

  it('when row level security hides the organization row, so MFA policy is unknown', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'admin', hideOrganization: true }];
    const { readTables } = await fallsBack();
    expect(readTables).toBe(true);
  });

  it('when the kill switch is set', async () => {
    process.env.REQUEST_CONTEXT_RPC = 'off';
    const { ctx, readTables } = await fallsBack();
    expect(ctx).not.toBeNull();
    expect(readTables).toBe(true);
    expect(world.calls).not.toContain('rpc:get_request_context');
  });

  it('says so when the answer is one it does not understand', async () => {
    // A shape this code cannot read is PERMANENT for that caller, and now costs
    // the RPC on top of the full legacy reads. A silent fallback would make a
    // dead fast path invisible and slower than before the change.
    world.rpc = 'junk';
    await withApiContext(cookie());
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain('unexpected answer');
  });

  it('stays quiet when the answer is legitimate but unusable (no readable profile)', async () => {
    world.hideProfile = true;
    await withApiContext(cookie());
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('unexpected answer');
  });

  it('logs a code, never a message', async () => {
    world.rpc = 'error';
    await withApiContext(cookie());
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain('legacy reads');
    expect(logged).not.toContain('socket');
  });
});

describe('an unreadable MFA policy denies, it does not default to optional', () => {
  // postgrest-js resolves a failed request as { data: null, error } — it does
  // NOT throw unless throwOnError is set, and this app never sets it. So a
  // statement timeout or a gateway 5xx on `organizations` used to fall through
  // to `?? 'optional'` and switch the MFA gate off for anyone not already
  // enrolled. Since 0167 the stored default is 'admins_required', so that was
  // more permissive than any real organization's policy.
  const legacyOnly = async (req: Request) => {
    process.env.REQUEST_CONTEXT_RPC = 'off';
    try {
      return await withApiContext(req);
    } finally {
      delete process.env.REQUEST_CONTEXT_RPC;
    }
  };

  it('fails CLOSED when the policy read errors, on the cookie path', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'staff' }];
    world.orgReadError = { code: '57014', message: 'canceling statement due to statement timeout' };
    const ctx = await legacyOnly(cookie());
    expect(ctx).not.toBeNull();
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it('fails CLOSED on the bearer path too, even with an aal2 token', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'admin' }];
    world.orgReadError = { code: '500', message: 'bad gateway' };
    world.aal = 'aal2';
    const ctx = await legacyOnly(bearer());
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);
  });

  it('holds a HIDDEN row to the strictest policy, never optional', async () => {
    // maybeSingle() reports zero rows as { data: null, error: null }. The
    // column is NOT NULL, so no row means row level security hid it from this
    // session. Until 2026-09-22 that became 'optional' and switched MFA off.
    world.memberships = [{ organization_id: ORG_A, role: 'staff' }];
    world.hideOrganization = true;
    world.aal = 'aal1';
    for (const req of [cookie(), bearer()]) {
      const ctx = await legacyOnly(req);
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(false);
    }
  });

  it('a session already at AAL2 still passes a hidden row: strict, not a lockout', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'staff' }];
    world.hideOrganization = true;
    world.verifiedFactor = true;
    world.aal = 'aal2';
    for (const req of [cookie(), bearer()]) {
      const ctx = await legacyOnly(req);
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(true);
    }
  });

  it('the one-round-trip path hands a hidden row to the legacy reads, which hold it as strictly', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'staff', hideOrganization: true }];
    world.hideOrganization = true;
    world.aal = 'aal1';
    for (const req of [cookie(), bearer()]) {
      world.calls = [];
      const ctx = await withApiContext(req);
      expect(world.calls).toContain('rpc:get_request_context');
      expect(world.calls).toContain('table:organizations');
      expect(ctx?.mfaRequired).toBe(true);
      expect(ctx?.mfaSatisfied).toBe(false);
    }
  });
});

describe('MFA is decided from the policy that came back with the membership', () => {
  it('an org that requires it for everyone still requires it', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'staff', mfa_policy: 'all_required' }];
    world.aal = 'aal1';
    const { fast, legacy } = await both(cookie());
    expect(shape(fast)).toEqual(shape(legacy));
    expect(fast?.mfaRequired).toBe(true);
    expect(fast?.mfaSatisfied).toBe(false);
  });

  it('an admins-only policy binds an admin and not a member of staff', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'admin', mfa_policy: 'admins_required' }];
    expect((await withApiContext(cookie()))?.mfaRequired).toBe(true);
    world.memberships = [{ organization_id: ORG_A, role: 'staff', mfa_policy: 'admins_required' }];
    expect((await withApiContext(cookie()))?.mfaRequired).toBe(false);
  });

  it('an enrolled factor escalates even under an optional policy', async () => {
    world.verifiedFactor = true;
    world.aal = 'aal1';
    const { fast, legacy } = await both(cookie());
    expect(shape(fast)).toEqual(shape(legacy));
    expect(fast?.mfaRequired).toBe(true);
    expect(fast?.mfaEnrolled).toBe(true);
    expect(fast?.mfaSatisfied).toBe(false);
  });

  it('asks the client for its assurance level only when MFA is actually required', async () => {
    world.calls = [];
    await withApiContext(cookie());
    expect(world.calls).not.toContain('auth:aal');
    world.memberships = [{ organization_id: ORG_A, role: 'staff', mfa_policy: 'all_required' }];
    world.calls = [];
    await withApiContext(cookie());
    expect(world.calls).toContain('auth:aal');
  });
});

describe('the bearer path gets the same treatment', () => {
  it('resolves in one round trip and reads no tables', async () => {
    world.calls = [];
    const ctx = await withApiContext(bearer());
    expect(ctx?.organizationId).toBe(ORG_A);
    expect(world.calls.filter((c) => c.startsWith('table:'))).toEqual([]);
    expect(world.calls).toContain('rpc:get_request_context');
  });

  it('reads assurance from the TOKEN, never from the client (it has no session)', async () => {
    world.memberships = [{ organization_id: ORG_A, role: 'staff', mfa_policy: 'all_required' }];
    world.aal = 'aal2';
    world.calls = [];
    const satisfied = await withApiContext(bearer());
    expect(satisfied?.mfaSatisfied).toBe(true);
    expect(world.calls).not.toContain('auth:aal');

    world.aal = 'aal1';
    const notSatisfied = await withApiContext(bearer());
    expect(notSatisfied?.mfaRequired).toBe(true);
    expect(notSatisfied?.mfaSatisfied).toBe(false);
  });

  it('escalates an enrolled factor there too, under an optional policy', async () => {
    // HI-6: a verified factor must be satisfied whatever the org policy says,
    // or a stolen password alone reaches /api/v1 at AAL1 untouched. The factor
    // is read off the GoTrue user the bearer token was validated against.
    world.verifiedFactor = true;
    world.aal = 'aal1';
    const ctx = await withApiContext(bearer());
    expect(ctx?.mfaRequired).toBe(true);
    expect(ctx?.mfaEnrolled).toBe(true);
    expect(ctx?.mfaSatisfied).toBe(false);

    world.aal = 'aal2';
    const stepped = await withApiContext(bearer());
    expect(stepped?.mfaRequired).toBe(true);
    expect(stepped?.mfaSatisfied).toBe(true);
  });

  it('refuses a disabled account and an organization the caller does not belong to', async () => {
    world.profile.disabled_at = '2026-09-01T00:00:00Z';
    expect(await withApiContext(bearer())).toBeNull();
    world.profile.disabled_at = null;
    expect(
      await withApiContext(bearer({ 'x-organization-id': 'cccccccc-3333-3333-3333-333333333333' })),
    ).toBeNull();
  });
});
