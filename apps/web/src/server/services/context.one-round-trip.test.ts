import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE get_request_context() PER SERVER ACTION.
 *
 * React `cache()` does not memoize inside a Server Action (the installed
 * react-server build: no request in scope, so every call gets a fresh cache).
 * `withContext()` used to reach three request-cached helpers that each asked
 * get_request_context() for themselves (requireOrgContext, getOrgRowForRequest,
 * getModulesForRequest): three RPCs per action, three snapshots of the database,
 * three chances at the 1 to 8 s stall measured at Supabase's entry point on
 * 2026-09-22. The membership that resolved the context already holds the org
 * row and the modules, so it is read from there.
 *
 * Outside a render, as here, `cache()` is a pass-through: exactly the Server
 * Action case. Everything below session.ts is REAL (session, request-cache, the
 * bundle parser, the MFA gate); only the network is faked, and it counts.
 */

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({ 'x-stockpilot-user-id': 'u1', 'x-stockpilot-user-email': 'u1@example.com' }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, getAll: () => [], set: () => {} })),
}));

interface OrgFixture {
  id: string;
  name: string;
  logo_url: null;
  terminology: null;
  mfa_policy: 'optional' | 'admins_required' | 'all_required';
  timezone: string;
  nav_overrides: null;
  dashboard_layout: null;
  order_status_config: null;
  all_modules_comp: boolean;
}

const state = {
  rpcAvailable: true,
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  /** null: row level security hides the organization row from this member. */
  org: null as OrgFixture | null,
  modules: ['orders'] as string[],
  factors: [] as Array<{ status: string }>,
  aal: 'aal1' as 'aal1' | 'aal2',
};
const calls = { rpc: 0, from: [] as string[], listFactors: 0, clients: [] as unknown[] };

const org = (extra: Partial<OrgFixture> = {}): OrgFixture => ({
  id: 'A',
  name: 'Org A',
  logo_url: null,
  terminology: null,
  mfa_policy: 'optional',
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: false,
  ...extra,
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = {
      rpc: async (fn: string) => {
        calls.rpc += 1;
        if (!state.rpcAvailable || fn !== 'get_request_context') {
          return { data: null, error: { code: 'PGRST202', message: 'not found' } };
        }
        return {
          error: null,
          data: {
            user_id: 'u1',
            profile: {
              id: 'u1',
              email: 'u1@example.com',
              full_name: 'Una One',
              avatar_url: null,
              default_organization_id: 'A',
              disabled_at: null,
            },
            memberships: [
              {
                organization_id: 'A',
                role: state.role,
                organization: state.org,
                role_overrides: [],
                user_overrides: [],
                enabled_modules: state.modules,
              },
            ],
          },
        };
      },
      // The legacy reads, for the paths that still take them.
      from: (table: string) => {
        calls.from.push(table);
        const rows = (): unknown => {
          switch (table) {
            case 'user_profiles':
              return {
                id: 'u1',
                email: 'u1@example.com',
                full_name: 'Una One',
                avatar_url: null,
                default_organization_id: 'A',
                disabled_at: null,
              };
            case 'organization_members':
              return [
                {
                  organization_id: 'A',
                  role: state.role,
                  organizations: state.org
                    ? { id: 'A', name: state.org.name, logo_url: null }
                    : null,
                },
              ];
            case 'role_permission_overrides':
            case 'user_permission_overrides':
              return [];
            case 'organizations': {
              if (!state.org) return null;
              const { id: _id, name: _name, ...settings } = state.org;
              return settings;
            }
            case 'organization_modules':
              return state.modules.map((module_id) => ({ module_id }));
            default:
              throw new Error(`unexpected table ${table}`);
          }
        };
        const builder: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not', 'is', 'neq', 'order', 'limit']) {
          builder[m] = () => builder;
        }
        builder.maybeSingle = async () => ({ data: rows(), error: null });
        builder.then = (ok: (v: unknown) => unknown) => ok({ data: rows(), error: null });
        return builder;
      },
      auth: {
        // Without the RPC's answer, session.ts verifies the cookie session
        // before trusting the identity header (the legacy-reads test).
        getClaims: async () => ({ data: { claims: { sub: 'u1' } }, error: null }),
        mfa: {
          listFactors: async () => {
            calls.listFactors += 1;
            return { data: { all: state.factors }, error: null };
          },
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: state.aal },
            error: null,
          }),
        },
      },
    };
    calls.clients.push(client);
    return client;
  },
}));

import { withContext } from './context';

beforeEach(() => {
  state.rpcAvailable = true;
  state.role = 'admin';
  state.org = org();
  state.modules = ['orders'];
  state.factors = [];
  state.aal = 'aal1';
  calls.rpc = 0;
  calls.from = [];
  calls.listFactors = 0;
  calls.clients = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('withContext() in a Server Action', () => {
  it('asks get_request_context() ONCE and reads no settings table', async () => {
    const ctx = await withContext();
    expect(calls.rpc).toBe(1);
    expect(calls.from).toEqual([]);
    expect(calls.listFactors).toBe(1);
    expect(ctx.organizationId).toBe('A');
    expect(ctx.role).toBe('admin');
    expect([...ctx.enabledModules]).toEqual(['orders']);
    expect(ctx.mfaRequired).toBe(false);
    expect(ctx.mfaSatisfied).toBe(true);
  });

  it('the MFA gate reads the policy off that same membership (strict policy, unenrolled admin)', async () => {
    state.org = org({ mfa_policy: 'all_required' });
    const ctx = await withContext();
    expect(calls.rpc).toBe(1);
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('admins_required exempts staff, from that membership too', async () => {
    state.org = org({ mfa_policy: 'admins_required' });
    state.role = 'staff';
    const ctx = await withContext();
    expect(calls.rpc).toBe(1);
    expect(ctx.mfaRequired).toBe(false);
  });

  it('an enrolled user must still step up (HI-6), and does at AAL2', async () => {
    state.factors = [{ status: 'verified' }];
    const atAal1 = await withContext();
    expect(atAal1.mfaRequired).toBe(true);
    expect(atAal1.mfaSatisfied).toBe(false);
    state.aal = 'aal2';
    const atAal2 = await withContext();
    expect(atAal2.mfaRequired).toBe(true);
    expect(atAal2.mfaSatisfied).toBe(true);
  });

  it('a comped organization gets its modules through the one rule, still in one RPC', async () => {
    state.org = org({ all_modules_comp: true });
    state.modules = [];
    const ctx = await withContext();
    expect(calls.rpc).toBe(1);
    expect(ctx.enabledModules.has('orders' as never)).toBe(true);
    expect(ctx.enabledModules.size).toBeGreaterThan(1);
  });

  it('an organization row RLS hides still takes the request-cached reader, and is held to the strictest policy', async () => {
    state.org = null;
    state.role = 'staff';
    const ctx = await withContext();
    // Not answered from the membership: the reader that tells "hidden" from
    // "failed" ran, as it always has.
    expect(calls.from).toContain('organizations');
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('without the RPC (legacy reads) nothing is held, and the answer is the same', async () => {
    state.rpcAvailable = false;
    state.org = org({ mfa_policy: 'all_required' });
    const ctx = await withContext();
    expect(calls.from).toEqual(expect.arrayContaining(['organizations', 'organization_modules']));
    expect([...ctx.enabledModules]).toEqual(['orders']);
    expect(ctx.mfaRequired).toBe(true);
    expect(ctx.mfaSatisfied).toBe(false);
  });

  it('marks its client as the request cookie client, and only its own client', async () => {
    const ctx = await withContext();
    expect(ctx.cookieClient).toBe(ctx.supabase);
    expect(calls.clients).toContain(ctx.supabase);
  });
});
