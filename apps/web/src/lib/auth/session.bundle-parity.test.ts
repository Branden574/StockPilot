import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PARITY: a request resolved through `get_request_context()` (one round trip,
 * migration 0355) must come out IDENTICAL to the same request resolved through
 * the legacy reads: same organization, role, name, permission set, switcher
 * list, settings row and module set; same redirects for a disabled account and
 * for an organization the user does not belong to.
 *
 * One fixture feeds BOTH paths through one fake client, so the only variable is
 * the path. The fake also counts, which is the point of the change: the bundle
 * path makes ONE call and never touches a table.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({ 'x-stockpilot-user-id': 'u1', 'x-stockpilot-user-email': 'u1@example.com' }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));

interface Fixture {
  profile: Record<string, unknown> | null;
  members: Array<{
    organization_id: string;
    role: string;
    org: Record<string, unknown> | null;
    roleOverrides: unknown[];
    userOverrides: unknown[];
    modules: string[];
  }>;
}
const ORG_FIELDS = {
  logo_url: null,
  terminology: { item: 'Asset' },
  mfa_policy: 'admins_required',
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: false,
};

let fixture: Fixture;
let rpcAvailable = true;
const calls = { rpc: 0, from: [] as string[] };

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    // Without the RPC's answer, session.ts verifies the cookie session before
    // trusting the identity header. Not a table read, so the counts are unchanged.
    auth: { getClaims: async () => ({ data: { claims: { sub: 'u1' } }, error: null }) },
    rpc: async (fn: string) => {
      calls.rpc += 1;
      if (!rpcAvailable || fn !== 'get_request_context')
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      return {
        error: null,
        data: {
          user_id: 'u1',
          profile: fixture.profile,
          memberships: fixture.members.map((m) => ({
            organization_id: m.organization_id,
            role: m.role,
            organization: m.org,
            role_overrides: m.roleOverrides,
            user_overrides: m.userOverrides,
            enabled_modules: m.modules,
          })),
        },
      };
    },
    from: (table: string) => {
      calls.from.push(table);
      const filters: Record<string, unknown> = {};
      // A real table has no order unless one is asked for. The fixture is written
      // oldest first; an UNORDERED legacy read gets it newest first, so a path
      // that forgets its ORDER BY picks a different organization here.
      let ordered = false;
      const result = () => {
        const member = fixture.members.find((m) => m.organization_id === filters.organization_id);
        switch (table) {
          case 'user_profiles':
            return fixture.profile;
          case 'organization_members':
            return filters.organization_id
              ? member
                ? {
                    role: member.role,
                    organizations: member.org ? { name: member.org.name } : null,
                  }
                : null
              : (ordered ? fixture.members : [...fixture.members].reverse()).map((m) => ({
                  organization_id: m.organization_id,
                  role: m.role,
                  organizations: m.org
                    ? { id: m.org.id, name: m.org.name, logo_url: m.org.logo_url }
                    : null,
                }));
          case 'role_permission_overrides':
            return member && member.role === filters.role ? member.roleOverrides : [];
          case 'user_permission_overrides':
            return member ? member.userOverrides : [];
          case 'organizations': {
            const org = fixture.members.find((m) => m.organization_id === filters.id)?.org;
            if (!org) return null;
            const { id: _id, name: _name, ...settings } = org;
            return settings;
          }
          case 'organization_modules':
            return (member?.modules ?? []).map((module_id) => ({ module_id }));
          default:
            throw new Error(`unexpected table ${table}`);
        }
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'not', 'is', 'limit', 'neq']) builder[m] = () => builder;
      builder.order = (col: string) => ((ordered = ordered || col === 'created_at'), builder);
      builder.eq = (col: string, val: unknown) => ((filters[col] = val), builder);
      builder.maybeSingle = async () => ({ data: result(), error: null });
      builder.then = (res: (v: unknown) => unknown) => res({ data: result(), error: null });
      return builder;
    },
  }),
}));

async function resolve(path: 'bundle' | 'legacy', orgId?: string) {
  rpcAvailable = path === 'bundle';
  calls.rpc = 0;
  calls.from = [];
  vi.resetModules();
  const session = await import('./session');
  const requestCache = await import('@/lib/dashboard/request-cache');
  let ctx: Awaited<ReturnType<typeof session.requireOrgContext>> | null = null;
  let redirected: string | null = null;
  try {
    ctx = await session.requireOrgContext(orgId);
  } catch (e) {
    redirected = String((e as Error).message);
  }
  const out = {
    redirected,
    organizationId: ctx?.organizationId ?? null,
    organizationName: ctx?.organizationName ?? null,
    role: ctx?.role ?? null,
    permissions: ctx?.permissions ? [...ctx.permissions].sort() : null,
    memberships: redirected ? null : await session.getSessionMemberships(),
    orgRow: ctx ? await requestCache.getOrgRowForRequest(ctx.organizationId) : null,
    modules: ctx ? [...(await requestCache.getModulesForRequest(ctx.organizationId))].sort() : null,
  };
  return { out, rpcCalls: calls.rpc, tables: [...calls.from] };
}

const member = (id: string, role: string, extra: Partial<Fixture['members'][number]> = {}) => ({
  organization_id: id,
  role,
  org: { id, name: `Org ${id}`, ...ORG_FIELDS },
  roleOverrides: [] as unknown[],
  userOverrides: [] as unknown[],
  modules: ['books', 'orders'],
  ...extra,
});
const profile = (extra: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'u1@example.com',
  full_name: 'Una One',
  avatar_url: null,
  default_organization_id: 'A',
  disabled_at: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('one round trip gives the same answer as seven', () => {
  it('a manager with a role-level revoke and a user-level grant', async () => {
    fixture = {
      profile: profile(),
      members: [
        member('A', 'manager', {
          roleOverrides: [
            { permission: 'items:delete', granted: false },
            { permission: 'items:update', granted: false },
          ],
          userOverrides: [{ permission: 'items:delete', granted: true }],
        }),
      ],
    };
    const bundle = await resolve('bundle');
    const legacy = await resolve('legacy');
    expect(bundle.out).toEqual(legacy.out);
    // and the answer is the right one, not merely the same one
    expect(bundle.out.role).toBe('manager');
    expect(bundle.out.permissions).toContain('items:delete'); // user grant wins over the role revoke
    expect(bundle.out.permissions).not.toContain('items:update'); // role revoke stands
    expect(bundle.out.orgRow?.mfa_policy).toBe('admins_required');
    expect(bundle.out.modules).toEqual(expect.arrayContaining(['books', 'orders']));
  });

  it('the bundle path reads NO table; without the function the legacy path reads all six', async () => {
    fixture = { profile: profile(), members: [member('A', 'staff')] };
    // (Outside a React render `cache()` does not memoize, so this test cannot
    // count calls per REQUEST; it can prove which SOURCE answered.)
    const bundle = await resolve('bundle');
    expect(bundle.rpcCalls).toBeGreaterThanOrEqual(1);
    expect(bundle.tables).toEqual([]);
    const legacy = await resolve('legacy');
    expect(legacy.rpcCalls).toBeGreaterThanOrEqual(1); // asked, and told the function is missing
    expect([...new Set(legacy.tables)].sort()).toEqual([
      'organization_members',
      'organization_modules',
      'organizations',
      'role_permission_overrides',
      'user_permission_overrides',
      'user_profiles',
    ]);
  });

  it('an owner is never overridable, on either path', async () => {
    fixture = {
      profile: profile(),
      members: [
        member('A', 'owner', {
          roleOverrides: [{ permission: 'items:delete', granted: false }],
          userOverrides: [{ permission: 'items:delete', granted: false }],
        }),
      ],
    };
    const bundle = await resolve('bundle');
    expect(bundle.out).toEqual((await resolve('legacy')).out);
    expect(bundle.out.permissions).toContain('items:delete');
  });

  it('the organization comes from a MEMBERSHIP, never from the stale default in the profile', async () => {
    fixture = {
      profile: profile({ default_organization_id: 'GONE' }),
      members: [member('B', 'staff')],
    };
    const bundle = await resolve('bundle');
    expect(bundle.out).toEqual((await resolve('legacy')).out);
    expect(bundle.out.organizationId).toBe('B');
  });

  // The SAME role in both organizations, and everything else different: a path
  // that read the FIRST membership's overrides, settings or modules for every
  // organization would still agree with itself, so the values are asserted.
  const twoOrgsSameRole = () => [
    member('A', 'manager', {
      roleOverrides: [{ permission: 'items:update', granted: false }],
      modules: ['books'],
    }),
    member('B', 'manager', {
      org: {
        id: 'B',
        name: 'Org B',
        ...ORG_FIELDS,
        mfa_policy: 'all_required',
        all_modules_comp: true,
      },
      roleOverrides: [{ permission: 'items:create', granted: false }], // a manager DEFAULT, revoked in B
      userOverrides: [{ permission: 'items:delete', granted: true }], // NOT a default, granted in B
      modules: ['orders'],
    }),
  ];

  it('several organizations: the default wins, with ITS overrides, settings and modules', async () => {
    fixture = { profile: profile({ default_organization_id: 'B' }), members: twoOrgsSameRole() };
    const bundle = await resolve('bundle');
    expect(bundle.out).toEqual((await resolve('legacy')).out);
    expect(bundle.tables).toEqual([]); // answered by the bundle, not by a quiet fall-through
    expect(bundle.out.organizationId).toBe('B');
    expect(bundle.out.role).toBe('manager');
    expect(bundle.out.permissions).toContain('items:delete'); // B: user grant of a non-default
    expect(bundle.out.permissions).not.toContain('items:create'); // B: role revoke of a default
    expect(bundle.out.permissions).toContain('items:update'); // revoked in A only
    expect(bundle.out.orgRow?.mfa_policy).toBe('all_required'); // B's policy, not A's
    expect(bundle.out.orgRow?.all_modules_comp).toBe(true);
    expect(bundle.out.modules).toContain('orders');
    expect(bundle.out.modules).toContain('books'); // comped: more than its one explicit row
    expect(bundle.out.memberships?.map((m) => m.organizationId)).toEqual(['A', 'B']);
  });

  it('several organizations and NO valid default: every path picks the OLDEST membership', async () => {
    fixture = { profile: profile({ default_organization_id: null }), members: twoOrgsSameRole() };
    const bundle = await resolve('bundle');
    const legacy = await resolve('legacy');
    expect(bundle.out.organizationId).toBe('A');
    expect(legacy.out.organizationId).toBe('A'); // needs the ORDER BY on the legacy read
    expect(bundle.out).toEqual(legacy.out);
    expect(bundle.out.permissions).not.toContain('items:update'); // A: role revoke
    expect(bundle.out.permissions).toContain('items:create'); // a manager default nothing in A revokes
    expect(bundle.out.permissions).not.toContain('items:delete'); // B's grant must not leak into A
    expect(bundle.out.orgRow?.mfa_policy).toBe('admins_required');
    expect(bundle.out.modules).toContain('books');
    expect(bundle.out.modules).not.toContain('orders'); // A is not comped and has no orders row
  });

  it('an explicit organization the user belongs to: that role, those overrides', async () => {
    fixture = {
      profile: profile({ default_organization_id: 'A' }),
      members: [
        member('A', 'owner'),
        member('B', 'viewer', { userOverrides: [{ permission: 'items:update', granted: true }] }),
      ],
    };
    const bundle = await resolve('bundle', 'B');
    expect(bundle.out).toEqual((await resolve('legacy', 'B')).out);
    expect(bundle.out.role).toBe('viewer');
    expect(bundle.out.permissions).toContain('items:update');
    expect(bundle.out.permissions).not.toContain('items:delete');
  });

  it('an explicit organization with the SAME role as the default one: still ITS overrides and settings', async () => {
    fixture = { profile: profile({ default_organization_id: 'A' }), members: twoOrgsSameRole() };
    const bundle = await resolve('bundle', 'B');
    expect(bundle.out).toEqual((await resolve('legacy', 'B')).out);
    expect(bundle.tables).toEqual([]);
    expect(bundle.out.organizationId).toBe('B');
    expect(bundle.out.organizationName).toBe('Org B');
    expect(bundle.out.permissions).toContain('items:delete'); // B's user grant
    expect(bundle.out.permissions).not.toContain('items:create'); // B's role revoke
    expect(bundle.out.permissions).toContain('items:update'); // A's revoke must not follow her into B
    expect(bundle.out.orgRow?.mfa_policy).toBe('all_required');
  });

  it('an explicit organization the user does NOT belong to: the same redirect, and no context', async () => {
    fixture = { profile: profile(), members: [member('A', 'owner')] };
    const bundle = await resolve('bundle', 'NOT-MINE');
    const legacy = await resolve('legacy', 'NOT-MINE');
    expect(bundle.out.redirected).toBe('REDIRECT:/onboarding');
    expect(legacy.out.redirected).toBe('REDIRECT:/onboarding');
    expect(bundle.out.organizationId).toBeNull();
  });

  it('no accepted membership at all: the same redirect', async () => {
    fixture = { profile: profile({ default_organization_id: null }), members: [] };
    expect((await resolve('bundle')).out.redirected).toBe('REDIRECT:/onboarding');
    expect((await resolve('legacy')).out.redirected).toBe('REDIRECT:/onboarding');
  });

  it('a DISABLED account is stopped at the same gate on both paths', async () => {
    fixture = {
      profile: profile({ disabled_at: '2026-09-21T10:00:00+00:00' }),
      members: [member('A', 'owner')],
    };
    const bundle = await resolve('bundle');
    const legacy = await resolve('legacy');
    expect(bundle.out.redirected).toMatch(/^REDIRECT:/);
    expect(bundle.out.redirected).toBe(legacy.out.redirected);
    expect(bundle.out.redirected).not.toBe('REDIRECT:/onboarding');
    expect(bundle.out.organizationId).toBeNull();
  });

  it('an organization row hidden by RLS: the settings and modules come from the legacy reads, not from a guess', async () => {
    fixture = { profile: profile(), members: [member('A', 'staff', { org: null })] };
    const bundle = await resolve('bundle');
    expect(bundle.out.organizationName).toBe('Workspace');
    expect(bundle.tables).toEqual(
      expect.arrayContaining(['organizations', 'organization_modules']),
    );
    expect(bundle.out.orgRow).toBeNull();
  });
});
