import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * requireOrgContext() sends a member who must set up an authenticator to the
 * security settings page, for every caller: each dashboard page by itself (a
 * navigation inside the dashboard renders only the page, not the layout
 * above it) and each Server Action that builds on the member's context,
 * directly or through withContext().
 *
 * Who must: the organization's policy requires an authenticator of their role
 * (everyone under all_required, owners and admins under admins_required) and
 * they have no verified factor. Where they may still go: the security page
 * and the profile page, by the proxy-set path, exactly or below it after a
 * slash. A missing path is neither, so the member is sent to set-up on every
 * such request (the proxy sets the path on every request it handles).
 *
 * session.ts, the gates, request-cache, the bundle parser and the verified
 * claims read are REAL; only the network is faked, and it counts. Outside a
 * render React cache() is a pass-through: exactly the Server Action case.
 */

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
vi.mock('next/headers', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    headers: async () => f.fixtureHeaders(),
    cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  };
});

/** The organization row as the legacy read answers it, when the bundle does not carry it. */
const legacy = vi.hoisted(() => ({
  /** get_request_context() does not answer: the session loader takes its own reads. */
  noBundle: false,
  hideOrganization: false,
  orgRow: { data: null as unknown, error: null as unknown },
}));
vi.mock('@/lib/supabase/server', async () => {
  const f = await import('@/test/step-up-session-fixture');
  return {
    createClient: async () => {
      const client = f.fixtureClient();
      const rpc = client.rpc;
      return {
        ...client,
        // The bundle with the organization row hidden from this member.
        rpc: async (fn: string) => {
          if (legacy.noBundle) {
            f.world.calls.push(`rpc:${fn}`);
            return { data: null, error: { code: 'PGRST202', message: 'not found' } };
          }
          const answer = await rpc(fn);
          if (!legacy.hideOrganization) return answer;
          const data = answer.data as { memberships: Array<Record<string, unknown>> };
          return {
            ...answer,
            data: {
              ...data,
              memberships: data.memberships.map((m) => ({ ...m, organization: null })),
            },
          };
        },
        from: (table: string) => {
          if (table === 'organizations' && !legacy.noBundle) {
            f.world.calls.push('from:organizations');
            const builder: Record<string, unknown> = {};
            for (const m of ['select', 'eq']) builder[m] = () => builder;
            builder.maybeSingle = async () => legacy.orgRow;
            return builder;
          }
          if (!legacy.noBundle) return client.from(table);
          // The session loader's own reads, for the made-up member of world.
          f.world.calls.push(`from:${table}`);
          const filters: Record<string, unknown> = {};
          const answer = () => {
            const orgId = filters.organization_id as string | undefined;
            switch (table) {
              case 'user_profiles':
                return {
                  id: f.USER,
                  email: f.EMAIL,
                  full_name: 'Example Person',
                  avatar_url: null,
                  default_organization_id: f.world.orgs[0] ?? null,
                  disabled_at: null,
                  deleted_at: null,
                };
              case 'organization_members':
                if (orgId) {
                  return f.world.orgs.includes(orgId)
                    ? { role: f.world.role, organizations: { name: `Org ${orgId.slice(0, 1)}` } }
                    : null;
                }
                return f.world.orgs.map((id) => ({
                  organization_id: id,
                  role: f.world.role,
                  organizations: { id, name: `Org ${id.slice(0, 1)}`, logo_url: null },
                }));
              case 'role_permission_overrides':
              case 'user_permission_overrides':
                return [];
              case 'organizations':
                return { mfa_policy: f.world.policy };
              default:
                throw new Error(`unexpected table read: ${table}`);
            }
          };
          const builder: Record<string, unknown> = {};
          for (const m of ['select', 'not', 'is', 'limit', 'neq', 'in', 'order']) {
            builder[m] = () => builder;
          }
          builder.eq = (col: string, val: unknown) => ((filters[col] = val), builder);
          builder.maybeSingle = async () => ({ data: answer(), error: null });
          builder.single = async () => ({ data: answer(), error: null });
          builder.then = (res: (v: unknown) => unknown) => res({ data: answer(), error: null });
          return builder;
        },
      };
    },
  };
});

import { withContext } from '@/server/services/context';
import {
  countCalls as count,
  ORG,
  ORG_2,
  redirectOf,
  resetWorld,
  VERIFIED_FACTOR as VERIFIED,
  world,
  type MemberRole as Role,
  type Policy,
} from '@/test/step-up-session-fixture';

import { requireOrgContext } from './session';

const SET_UP = '/dashboard/settings/security?enroll=1';
const ROLES: Role[] = ['owner', 'admin', 'manager', 'staff', 'viewer'];
const POLICIES: Policy[] = ['optional', 'admins_required', 'all_required'];
const requires = (policy: Policy, role: Role) =>
  policy === 'all_required' ||
  (policy === 'admins_required' && (role === 'owner' || role === 'admin'));
const MATRIX = POLICIES.flatMap((p) => ROLES.map((r) => [p, r] as const));

const PAGES = [
  '/dashboard',
  '/dashboard/inventory',
  '/dashboard/team',
  '/dashboard/settings/integrations',
];
const OPEN_PAGES = [
  '/dashboard/settings/security',
  '/dashboard/settings/security/',
  '/dashboard/settings/profile',
];
const NOT_OPEN = [
  '/dashboard/settings/security-keys',
  '/dashboard/settings/securityx',
  '/dashboard/settings/profile-old',
  '/dashboard/settings',
  '/dashboard/settings/security.json',
];

function as(policy: Policy, role: Role, pathname: string | null = '/dashboard/inventory') {
  world.policy = policy;
  world.role = role;
  world.pathname = pathname;
}

beforeEach(() => {
  redirect.mockClear();
  resetWorld();
  legacy.noBundle = false;
  legacy.hideOrganization = false;
  legacy.orgRow = { data: null, error: null };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('requireOrgContext(): a member with no authenticator, on a dashboard page', () => {
  it.each(MATRIX)(
    '%s, %s: sent to set-up exactly when the policy requires one',
    async (policy, role) => {
      for (const page of PAGES) {
        as(policy, role, page);
        expect(await redirectOf(() => requireOrgContext()), page).toBe(
          requires(policy, role) ? SET_UP : null,
        );
      }
    },
  );

  it.each(MATRIX)('%s, %s: withContext() gives the same answer', async (policy, role) => {
    as(policy, role);
    expect(await redirectOf(() => withContext())).toBe(requires(policy, role) ? SET_UP : null);
  });

  it.each(MATRIX)(
    '%s, %s whose only factor is not verified: the same as none',
    async (policy, role) => {
      as(policy, role);
      world.factors = [{ status: 'unverified' }];
      expect(await redirectOf(() => requireOrgContext())).toBe(
        requires(policy, role) ? SET_UP : null,
      );
    },
  );

  it('an explicit organization is held to the same rule', async () => {
    world.orgs = [ORG, ORG_2];
    as('admins_required', 'admin');
    expect(await redirectOf(() => requireOrgContext(ORG_2))).toBe(SET_UP);
    as('admins_required', 'manager');
    expect((await requireOrgContext(ORG_2)).organizationId).toBe(ORG_2);
  });
});

describe('requireOrgContext(): a member with a verified authenticator', () => {
  it.each(MATRIX)('%s, %s at aal2: the context, on any page', async (policy, role) => {
    world.factors = VERIFIED;
    world.aal = 'aal2';
    for (const page of PAGES) {
      as(policy, role, page);
      expect((await requireOrgContext()).organizationId).toBe(ORG);
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each(MATRIX)('%s, %s at aal1: the code page, not set-up', async (policy, role) => {
    as(policy, role);
    world.factors = VERIFIED;
    expect(await redirectOf(() => requireOrgContext())).toMatch(/^\/signin\/mfa\?/);
  });
});

describe('the pages open before set-up', () => {
  it.each(MATRIX)(
    '%s, %s with no authenticator: the context on each open page',
    async (policy, role) => {
      for (const page of OPEN_PAGES) {
        as(policy, role, page);
        expect((await requireOrgContext()).organizationId, page).toBe(ORG);
        expect((await withContext()).organizationId, page).toBe(ORG);
      }
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it.each(NOT_OPEN)('%s is not open: an owner who must set up is sent there', async (page) => {
    as('admins_required', 'owner', page);
    expect(await redirectOf(() => requireOrgContext())).toBe(SET_UP);
  });

  it('the redirect lands on an open page: following it gives the context, one hop', async () => {
    as('admins_required', 'admin', '/dashboard/team');
    const to = await redirectOf(() => requireOrgContext());
    expect(to).toBe(SET_UP);
    world.pathname = new URL(to!, 'https://example.test').pathname;
    expect((await requireOrgContext()).organizationId).toBe(ORG);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('with no path header the member is sent to set-up on every request, the set-up page included: it fails closed', async () => {
    // The deployed proxy sets the path on every request it handles; a request
    // without it is answered with the redirect, every time.
    as('admins_required', 'admin', null);
    for (let i = 0; i < 3; i++) {
      expect(await redirectOf(() => requireOrgContext())).toBe(SET_UP);
    }
    expect(redirect).toHaveBeenCalledTimes(3);
  });

  it('an open page asks nothing more: no read beyond the context and the code gate', async () => {
    as('admins_required', 'admin', '/dashboard/settings/security');
    await requireOrgContext();
    expect(count('auth:getUser')).toBe(1);
    expect(count('rpc:get_request_context')).toBe(1);
    expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
  });
});

describe('what the rule costs', () => {
  it("a member with no authenticator: the code gate's own factor read and the membership, nothing else", async () => {
    for (const [policy, role] of MATRIX) {
      world.calls = [];
      as(policy, role);
      await redirectOf(() => requireOrgContext());
      expect(count('auth:getUser'), `${policy} ${role}`).toBe(1);
      expect(count('rpc:get_request_context')).toBe(1);
      expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
    }
  });

  it('at aal2: no call to the Auth server and no table read', async () => {
    as('all_required', 'owner');
    world.factors = VERIFIED;
    world.aal = 'aal2';
    await requireOrgContext();
    expect(count('auth:getUser')).toBe(0);
    expect(world.calls.filter((c) => c.startsWith('from:'))).toEqual([]);
  });
});

describe('an organization row the member cannot read: held to the strictest policy, as before', () => {
  beforeEach(() => {
    legacy.hideOrganization = true;
  });

  it.each(ROLES)(
    'a row that came back empty: a %s with no authenticator is sent to set-up',
    async (role) => {
      as('optional', role);
      legacy.orgRow = { data: null, error: null };
      expect(await redirectOf(() => requireOrgContext())).toBe(SET_UP);
      expect(count('from:organizations')).toBe(1);
    },
  );

  it.each(ROLES)(
    'a row that came back empty: a %s on the security page gets the context',
    async (role) => {
      as('optional', role, '/dashboard/settings/security');
      expect((await requireOrgContext()).organizationId).toBe(ORG);
    },
  );

  it('a read that failed: the "could not check your access" error, never a context and never a redirect', async () => {
    as('optional', 'staff');
    legacy.orgRow = { data: null, error: { code: '57014', message: 'canceling statement' } };
    await expect(requireOrgContext()).rejects.toMatchObject({
      name: 'OrganizationRowUnavailableError',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a row read by the legacy path that says optional: the context', async () => {
    as('admins_required', 'owner');
    legacy.orgRow = { data: { mfa_policy: 'optional' }, error: null };
    expect((await requireOrgContext()).organizationId).toBe(ORG);
  });
});

describe('without the one-round-trip context read (the session loader takes its own reads)', () => {
  beforeEach(() => {
    legacy.noBundle = true;
    world.orgs = [ORG, ORG_2];
  });

  it('an explicit organization: an owner who must set up is sent there; a manager gets the context', async () => {
    as('admins_required', 'owner');
    expect(await redirectOf(() => requireOrgContext(ORG_2))).toBe(SET_UP);
    expect(count('rpc:get_request_context')).toBeGreaterThanOrEqual(1);
    as('admins_required', 'manager');
    expect((await requireOrgContext(ORG_2)).organizationId).toBe(ORG_2);
    // The legacy membership read for that organization, and its policy row.
    expect(world.calls).toContain('from:organization_members');
    expect(world.calls).toContain('from:organizations');
  });

  it('an explicit organization on the security page: the context', async () => {
    as('all_required', 'staff', '/dashboard/settings/security');
    expect((await requireOrgContext(ORG_2)).organizationId).toBe(ORG_2);
  });

  it('the default organization: the same rule', async () => {
    as('all_required', 'viewer');
    expect(await redirectOf(() => requireOrgContext())).toBe(SET_UP);
    as('optional', 'viewer');
    expect((await requireOrgContext()).organizationId).toBe(ORG);
  });
});
