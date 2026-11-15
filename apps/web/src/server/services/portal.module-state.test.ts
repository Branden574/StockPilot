import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer portal and its organization's modules.
 *
 * resolvePortalContext() opens the portal only when the supplier organization
 * has the b2b_portal module switched on, and portalReturnsEnabled() offers
 * "Request a return" only when its returns module is on. Both read the
 * explicit enabled row with the service-role client.
 *
 * A module that is off is an answer: no portal ("not a portal user"), no
 * return button. A module state that could not be read is not: supabase-js
 * resolves a failed read as `{ data: null, error }`, the shape of "no enabled
 * row", and both functions throw for it (ModulesUnavailableError), as
 * resolvePortalContext already does for an account status it could not read.
 * The page then reaches its error state with Try again. Nothing is opened on
 * a read that did not answer.
 *
 * Made-up people and organizations only.
 */

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const USER = '11111111-2222-4333-8444-555555555555';

type Answer = { data: unknown; error: unknown };
const state = vi.hoisted(() => ({
  modules: { data: null, error: null } as { data: unknown; error: unknown },
  adminTables: [] as string[],
  updates: [] as string[],
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER, factors: [] } }, error: null }) },
  }),
}));
vi.mock('@/lib/auth/account-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-status')>()),
  loadAccountStatus: async () => 'active',
}));
vi.mock('@/lib/auth/step-up-gate', () => ({ stepUpIsOwedByUser: async () => false }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));
vi.mock('@/server/services/returns-requester', () => ({
  trackingRowsForOrders: vi.fn(async () => new Map()),
}));

function table(name: string, single: Answer, list: Answer = { data: [], error: null }) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ['select', 'eq', 'is']) q[m] = self;
  q.update = () => {
    state.updates.push(name);
    return q;
  };
  q.maybeSingle = async () => single;
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(list).then(resolve);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (name: string) => {
      state.adminTables.push(name);
      if (name === 'customer_users') {
        return table(
          name,
          { data: null, error: null },
          {
            data: [
              {
                customer_id: CUSTOMER,
                email: 'buyer@example.test',
                // Not accepted yet: resolving the context would stamp it.
                accepted_at: null,
                invited_at: '2026-09-01T00:00:00Z',
                customer: {
                  id: CUSTOMER,
                  name: 'Example Customer',
                  status: 'active',
                  organization_id: ORG,
                  price_list_id: null,
                },
              },
            ],
            error: null,
          },
        );
      }
      if (name === 'organization_modules') return table(name, state.modules);
      if (name === 'organizations') {
        return table(name, {
          data: { name: 'Example Supplier', logo_url: null, plan: null, access_tier: 'business' },
          error: null,
        });
      }
      return table(name, { data: null, error: null });
    },
  }),
}));

import { ModulesUnavailableError } from '@/lib/modules/module-state';

import { portalReturnsEnabled, resolvePortalContext, type PortalContext } from './portal';

const ON = (moduleId: string): Answer => ({ data: { module_id: moduleId, settings: null }, error: null });
const OFF: Answer = { data: null, error: null };
const FAILED: Answer = { data: null, error: { message: 'upstream timeout', code: '57014' } };

beforeEach(() => {
  state.modules = OFF;
  state.adminTables = [];
  state.updates = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('resolvePortalContext: the b2b_portal module', () => {
  it('the module on: the customer gets their portal', async () => {
    state.modules = ON('b2b_portal');
    const ctx = await resolvePortalContext();
    expect(ctx).toMatchObject({ customerId: CUSTOMER, organizationId: ORG });
  });

  it('the module off: not a portal user, and the invitation is not marked accepted', async () => {
    expect(await resolvePortalContext()).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it('the module state could not be read: the try-again error, never "not a portal user", and nothing is written', async () => {
    state.modules = FAILED;
    await expect(resolvePortalContext()).rejects.toBeInstanceOf(ModulesUnavailableError);
    expect(state.updates).toEqual([]);
  });
});

describe('portalReturnsEnabled: the returns module', () => {
  const ctx = { organizationId: ORG } as PortalContext;

  it('on is true and off is false, by an answer', async () => {
    state.modules = ON('returns');
    expect(await portalReturnsEnabled(ctx)).toBe(true);
    state.modules = OFF;
    expect(await portalReturnsEnabled(ctx)).toBe(false);
  });

  it('a state that could not be read is the try-again error, never false', async () => {
    state.modules = FAILED;
    await expect(portalReturnsEnabled(ctx)).rejects.toBeInstanceOf(ModulesUnavailableError);
  });
});
