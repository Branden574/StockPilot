import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The customer portal's Server Actions when the portal context cannot be
 * resolved because a check could not be read.
 *
 * resolvePortalContext() (the real one here) throws when the supplier
 * organization's b2b_portal module state, or the account's status, could not
 * be read: neither is "not a portal user". Each of the four portal actions
 * answers that as a result the page can show, "Your access could not be
 * checked. Please try again." (the account status keeps its own sentence),
 * reported once as a warning, and does nothing else: no rate-limit slot is
 * spent, no service is called, nothing is written. A module that is off is
 * still "Your account does not have portal access."; a redirect to the code
 * page still gets out.
 *
 * Made-up people and organizations only.
 */

const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const USER = '11111111-2222-4333-8444-555555555555';
const ORDER = '99999999-9999-4999-8999-999999999999';
const LINE = '88888888-8888-4888-8888-888888888888';

type Answer = { data: unknown; error: unknown };
const state = vi.hoisted(() => ({
  modules: { data: null, error: null } as { data: unknown; error: unknown },
  status: 'active' as 'active' | 'disabled' | 'unreadable',
  owesCode: false,
  writes: [] as string[],
}));
const spies = vi.hoisted(() => ({
  reportError: vi.fn(async (_e: unknown, _ctx?: unknown) => undefined),
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
  createPortalReturn: vi.fn(),
  loadPortalReturnSheet: vi.fn(),
  exchangeOptionsForPortal: vi.fn(),
}));

// next/navigation is the real one: the redirect to the code page is Next's own
// control flow, and the actions must let exactly that out.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER, factors: [] } }, error: null }) },
  }),
}));
vi.mock('@/lib/auth/account-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-status')>()),
  loadAccountStatus: async () => state.status,
}));
vi.mock('@/lib/auth/step-up-gate', () => ({ stepUpIsOwedByUser: async () => state.owesCode }));
vi.mock('@/lib/error-reporter', () => ({ reportError: spies.reportError }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: spies.checkRateLimit }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  createPortalReturn: spies.createPortalReturn,
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));
vi.mock('@/server/services/returns-requester', () => ({
  loadPortalReturnSheet: spies.loadPortalReturnSheet,
  exchangeOptionsForPortal: spies.exchangeOptionsForPortal,
  trackingRowsForOrders: vi.fn(async () => new Map()),
}));

function table(name: string, single: Answer, list: Answer = { data: [], error: null }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit']) q[m] = () => q;
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    q[m] = () => {
      state.writes.push(`${name}.${m}`);
      return q;
    };
  }
  q.maybeSingle = async () => single;
  q.single = async () => single;
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(list).then(resolve);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string) => {
      state.writes.push(`rpc:${name}`);
      return { data: null, error: null };
    },
    from: (name: string) => {
      if (name === 'customer_users') {
        return table(
          name,
          { data: null, error: null },
          {
            data: [
              {
                customer_id: CUSTOMER,
                email: 'buyer@example.test',
                // Not accepted yet: a resolved context would stamp it.
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

import {
  portalReturnOptionsAction,
  portalReturnSheetAction,
  requestPortalReturnAction,
  submitPortalOrderAction,
} from './portal';

const FAILED: Answer = { data: null, error: { message: 'upstream timeout', code: '57014' } };
const OFF: Answer = { data: null, error: null };

const ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ['place an order', () => submitPortalOrderAction({ lines: [{ itemId: LINE, quantity: 1 }] })],
  [
    'request a return',
    () =>
      requestPortalReturnAction({
        orderId: ORDER,
        lines: [{ orderRequestLineId: LINE, quantity: 1 }],
      }),
  ],
  ['open the return sheet', () => portalReturnSheetAction(ORDER)],
  ['load the exchange sizes', () => portalReturnOptionsAction(ORDER)],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.modules = OFF;
  state.status = 'active';
  state.owesCode = false;
  state.writes = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('portal Server Actions: the portal module state could not be read', () => {
  it.each(ACTIONS)('%s: answers the try-again sentence as a result, and does nothing else', async (_n, run) => {
    state.modules = FAILED;
    await expect(run()).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Your access could not be checked. Please try again.',
      },
    });
    // Refused before any work: no limiter slot, no service, no write.
    expect(spies.checkRateLimit).not.toHaveBeenCalled();
    expect(spies.createPortalReturn).not.toHaveBeenCalled();
    expect(spies.loadPortalReturnSheet).not.toHaveBeenCalled();
    expect(spies.exchangeOptionsForPortal).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(spies.reportError).toHaveBeenCalledTimes(1);
    expect(spies.reportError.mock.calls[0]![0]).toMatchObject({ name: 'ModulesUnavailableError' });
    expect(spies.reportError.mock.calls[0]![1]).toMatchObject({ level: 'warning' });
  });
});

describe('portal Server Actions: the account status could not be read', () => {
  it.each(ACTIONS)('%s: answers that check\'s own sentence as a result, and writes nothing', async (_n, run) => {
    state.modules = { data: { module_id: 'b2b_portal', settings: null }, error: null };
    state.status = 'unreadable';
    await expect(run()).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Account status could not be verified. Please try again.',
      },
    });
    expect(state.writes).toEqual([]);
  });
});

describe('portal Server Actions: answers that were read are unchanged', () => {
  it.each(ACTIONS)('%s: a portal module that is off is "no portal access", unreported', async (_n, run) => {
    await expect(run()).resolves.toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Your account does not have portal access.' },
    });
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it.each(ACTIONS)('%s: a session that owes its code is still sent to the code page', async (_n, run) => {
    state.owesCode = true;
    await expect(run()).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
    expect(spies.reportError).not.toHaveBeenCalled();
  });
});
