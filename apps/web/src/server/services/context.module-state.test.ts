import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * The module set withContext() gives a Server Action or a page service.
 *
 * When the one-round-trip context read gives no usable answer, the set is
 * built from the organization's enabled `organization_modules` rows and its
 * comp flag. supabase-js resolves a failed read as `{ data: null, error }`.
 * A module state those reads could not decide is held as unknown
 * (lib/modules/module-state): asking about it throws ModulesUnavailableError,
 * which an action answers with its try-again sentence and a page shows as its
 * error state. A set that was read answers exactly as before: a module that
 * is off is refused as module_disabled.
 *
 * Outside a render, as here, React `cache()` is a pass-through: the Server
 * Action case. Everything below session.ts is real (session, request-cache,
 * the bundle parser, the MFA gate); only the network is faked.
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

const ORG_SETTINGS = {
  logo_url: null,
  terminology: null,
  mfa_policy: 'optional',
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
};

const state = {
  /** get_request_context() answers. */
  rpcAvailable: true,
  comp: false,
  modules: ['orders'] as string[],
  /** What the organization_modules read resolves to, when it is not the rows. */
  modulesAnswer: null as { data: unknown; error: unknown } | null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (fn: string) => {
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
              role: 'manager',
              organization: {
                id: 'A',
                name: 'Org A',
                ...ORG_SETTINGS,
                all_modules_comp: state.comp,
              },
              role_overrides: [],
              user_overrides: [],
              enabled_modules: state.modules,
            },
          ],
        },
      };
    },
    from: (table: string) => {
      const answer = (): { data: unknown; error: unknown } => {
        switch (table) {
          case 'user_profiles':
            return {
              error: null,
              data: {
                id: 'u1',
                email: 'u1@example.com',
                full_name: 'Una One',
                avatar_url: null,
                default_organization_id: 'A',
                disabled_at: null,
              },
            };
          case 'organization_members':
            return {
              error: null,
              data: [
                {
                  organization_id: 'A',
                  role: 'manager',
                  organizations: { id: 'A', name: 'Org A', logo_url: null },
                },
              ],
            };
          case 'role_permission_overrides':
          case 'user_permission_overrides':
            return { data: [], error: null };
          case 'organizations':
            return { data: { ...ORG_SETTINGS, all_modules_comp: state.comp }, error: null };
          case 'organization_modules':
            return (
              state.modulesAnswer ?? {
                data: state.modules.map((module_id) => ({ module_id })),
                error: null,
              }
            );
          default:
            throw new Error(`unexpected table ${table}`);
        }
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'neq', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      builder.maybeSingle = async () => answer();
      builder.then = (ok: (v: unknown) => unknown) => ok(answer());
      return builder;
    },
    auth: {
      getClaims: async () => ({ data: { claims: { sub: 'u1', aal: 'aal1' } }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: 'stored.token' } },
        error: null,
      }),
      getUser: async () => ({ data: { user: { id: 'u1', factors: [] } }, error: null }),
    },
  }),
}));

import { ModulesUnavailableError, moduleSetUnreadable } from '@/lib/modules/module-state';

import { assertModuleEnabled, isModuleEnabled, ServiceError, withContext } from './context';

const NON_CORE = (Object.keys(MODULE_REGISTRY) as ModuleId[]).filter(
  (m) => MODULE_REGISTRY[m].tier !== 'core',
);
const CORE = (Object.keys(MODULE_REGISTRY) as ModuleId[]).filter(
  (m) => MODULE_REGISTRY[m].tier === 'core',
);
const ROWS_FAILED = { data: null, error: { message: 'upstream timeout', code: '57014' } };

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  state.rpcAvailable = true;
  state.comp = false;
  state.modules = ['orders'];
  state.modulesAnswer = null;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('withContext(): a module set that was read', () => {
  it.each([true, false])(
    'one round trip answering (%s): on is on, off is refused as module_disabled',
    async (rpcAvailable) => {
      state.rpcAvailable = rpcAvailable;
      const ctx = await withContext();
      expect(moduleSetUnreadable(ctx.enabledModules)).toBe(false);
      expect(isModuleEnabled(ctx, 'orders')).toBe(true);
      expect(isModuleEnabled(ctx, 'cycle_counts')).toBe(false);
      const refusal = thrownBy(() => assertModuleEnabled(ctx, 'cycle_counts'));
      expect(refusal).toBeInstanceOf(ServiceError);
      expect((refusal as ServiceError).code).toBe('module_disabled');
    },
  );

  it('an organization with every module off: every non-core module is off, by an answer', async () => {
    state.rpcAvailable = false;
    state.modules = [];
    const ctx = await withContext();
    expect(moduleSetUnreadable(ctx.enabledModules)).toBe(false);
    for (const id of NON_CORE) expect(isModuleEnabled(ctx, id)).toBe(false);
  });
});

describe('withContext(): module rows that could not be read', () => {
  beforeEach(() => {
    state.rpcAvailable = false;
    state.modulesAnswer = ROWS_FAILED;
  });

  it('holds the state as unknown: asking about a non-core module is the try-again error, never module_disabled', async () => {
    const ctx = await withContext();
    expect(moduleSetUnreadable(ctx.enabledModules)).toBe(true);
    for (const id of NON_CORE) {
      const asked = thrownBy(() => assertModuleEnabled(ctx, id));
      expect(asked).toBeInstanceOf(ModulesUnavailableError);
      expect((asked as Error).message).toBe('Your access could not be checked. Please try again.');
      expect(() => isModuleEnabled(ctx, id)).toThrow(ModulesUnavailableError);
    }
  });

  it('a core module still answers on: a request that asks about no optional module goes on', async () => {
    const ctx = await withContext();
    for (const id of CORE) {
      expect(isModuleEnabled(ctx, id)).toBe(true);
      expect(() => assertModuleEnabled(ctx, id)).not.toThrow();
    }
  });

  it('the set cannot be listed as if it were the organization\'s modules', async () => {
    const ctx = await withContext();
    expect(() => Array.from(ctx.enabledModules)).toThrow(ModulesUnavailableError);
    expect(() => ctx.enabledModules.size).toThrow(ModulesUnavailableError);
  });

  it('a comp that was read still grants every non-core module, as a plain set', async () => {
    state.comp = true;
    const ctx = await withContext();
    expect(moduleSetUnreadable(ctx.enabledModules)).toBe(false);
    for (const id of NON_CORE) expect(isModuleEnabled(ctx, id)).toBe(true);
  });

  it.each([
    ['an empty body with no error', { data: null, error: null }],
    ['a row that names no module', { data: [{ enabled: true }], error: null }],
  ])('%s is not an answer either', async (_name, answer) => {
    state.modulesAnswer = answer;
    const ctx = await withContext();
    expect(moduleSetUnreadable(ctx.enabledModules)).toBe(true);
    expect(() => assertModuleEnabled(ctx, 'orders')).toThrow(ModulesUnavailableError);
  });

  it('does not stick: the next request that reads the rows answers on and off again', async () => {
    await withContext();
    state.modulesAnswer = null;
    const ctx = await withContext();
    expect(isModuleEnabled(ctx, 'orders')).toBe(true);
    expect(isModuleEnabled(ctx, 'cycle_counts')).toBe(false);
  });
});
