import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';

/**
 * A Server Action when the organization row cannot be read.
 *
 * withContext() reads the organization row twice over: for the authenticator
 * policy (held to the strictest policy when the read fails) and for the comp
 * flag the module set is built from. The second read rejects, so the action
 * never runs on a context it could not build. The action answers the
 * "could not check your access" sentence as an internal_error, reported once
 * as a warning, never "Something went wrong", and nothing is written.
 *
 * Everything below session.ts is real (session, request-cache, the bundle
 * parser, the MFA gate, withContext, the action's mapping); only the network
 * is faked. Outside a render React `cache()` is a pass-through, which is the
 * Server Action case.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
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
  all_modules_comp: false,
};

const state = {
  role: 'manager' as 'owner' | 'manager',
  /** What the organizations read answers. */
  organizations: { data: ORG_SETTINGS, error: null } as { data: unknown; error: unknown },
  /** Every write the stub was asked for. */
  writes: [] as string[],
  rpcs: [] as string[],
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    // get_request_context() gives no usable answer: the legacy reads, where
    // the organization row is read on its own.
    rpc: async (fn: string) => {
      state.rpcs.push(fn);
      return { data: null, error: { code: 'PGRST202', message: 'not found' } };
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
                  role: state.role,
                  organizations: { id: 'A', name: 'Org A', logo_url: null },
                },
              ],
            };
          case 'role_permission_overrides':
          case 'user_permission_overrides':
            return { data: [], error: null };
          case 'organizations':
            return state.organizations;
          case 'organization_modules':
            return { data: [{ module_id: 'purchase_orders' }], error: null };
          default:
            throw new Error(`unexpected table ${table}`);
        }
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'neq', 'order', 'limit']) {
        builder[m] = () => builder;
      }
      for (const m of ['insert', 'update', 'upsert', 'delete']) {
        builder[m] = () => {
          state.writes.push(`${table}.${m}`);
          return builder;
        };
      }
      builder.maybeSingle = async () => answer();
      builder.single = async () => answer();
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

import { setPoApprovalSettingsAction } from './po-approval-settings';

const TRY_AGAIN = 'Your access could not be checked. Please try again.';
const ROW_FAILED = {
  data: null,
  error: { message: 'permission denied for table organizations', code: '42501' },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.role = 'manager';
  state.organizations = { data: ORG_SETTINGS, error: null };
  state.writes = [];
  state.rpcs = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('a Server Action whose organization row could not be read', () => {
  it.each(['manager', 'owner'] as const)(
    '%s: the try-again sentence, reported once as a warning, and nothing written',
    async (role) => {
      state.role = role;
      state.organizations = ROW_FAILED;
      const res = await setPoApprovalSettingsAction({ approvalThresholdAmount: 500 });
      expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: TRY_AGAIN } });
      expect(JSON.stringify(res)).not.toMatch(/Something went wrong|permission denied|42501/);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reportError).mock.calls[0]![0]).toMatchObject({
        name: 'OrganizationRowUnavailableError',
      });
      expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ level: 'warning' });
      expect(state.writes).toEqual([]);
      expect(state.rpcs.filter((fn) => fn !== 'get_request_context')).toEqual([]);
    },
  );
});

describe('the same action when the organization row was read', () => {
  it('a manager: its own refusal, as before, unreported', async () => {
    const res = await setPoApprovalSettingsAction({ approvalThresholdAmount: 500 });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Only owners and admins can change the PO approval threshold.',
      },
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
