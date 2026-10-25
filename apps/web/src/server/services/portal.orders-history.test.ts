import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * The B2B portal's "Your orders" (B32). It read the customer's 50 newest
 * orders and said nothing past them, and a read that failed was an empty
 * history: "No orders yet", a claim about the customer's orders made from an
 * error. It now answers the newest PORTAL_ORDERS_SHOWN with the exact count,
 * so the page can say how many it leaves out, and a failed read throws.
 */

const { adminRef } = vi.hoisted(() => ({ adminRef: { current: null as unknown } }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));
vi.mock('@/server/services/returns-requester', () => ({
  trackingRowsForOrders: vi.fn(async () => []),
}));

import { PORTAL_ORDERS_SHOWN, portalOrders, type PortalContext } from './portal';

const ORG = '00000000-0000-4000-8000-000000000001';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';

const ctx: PortalContext = {
  userId: 'u-portal',
  email: 'buyer@example.test',
  customerId: CUSTOMER,
  customerName: 'Test Customer',
  organizationId: ORG,
  orgName: 'Test Supplier',
  orgLogoUrl: null,
  priceListId: null,
  pricingMode: 'priced',
};

/** Order `i`, placed `i` minutes after a fixed start: a higher `i` is newer. */
function order(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    status: 'completed',
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    organization_id: ORG,
    customer_id: CUSTOMER,
    lines: [],
    ...over,
  };
}

/** order_requests as PostgREST answers: the call's filters, order and limit,
 *  and the exact count of the rows they match when the select asks for it. */
function served(rows: Array<Record<string, unknown>>) {
  const serve = servedLikePostgrest(rows);
  return (call: MockCall) => {
    const answer = serve(call);
    const selectArgs = call.args[call.methods.indexOf('select')] as [string, { count?: string }?];
    if (selectArgs?.[1]?.count !== 'exact') return answer;
    const keep = call.methods.map((m) => m !== 'limit' && m !== 'range');
    const everything = serve({
      ...call,
      methods: call.methods.filter((_, i) => keep[i]),
      args: call.args.filter((_, i) => keep[i]),
    });
    return { ...answer, count: (everything.data as unknown[]).length };
  };
}

function wire(rows: Array<Record<string, unknown>>) {
  const stub = makeSupabaseStub({ 'order_requests.select': served(rows) });
  adminRef.current = stub.client;
  return stub;
}

beforeEach(() => {
  adminRef.current = null;
});

describe('portalOrders: the newest orders, and how many there are', () => {
  it('shows the newest 50', () => {
    expect(PORTAL_ORDERS_SHOWN).toBe(50);
  });

  it('50 orders: all of them, and the count says 50', async () => {
    wire(Array.from({ length: 50 }, (_, i) => order(i)));
    const history = await portalOrders(ctx);
    expect(history.orders).toHaveLength(50);
    expect(history.total).toBe(50);
  });

  // Mutation caught: the old read, which answered 50 rows and no count.
  it('51 orders: the newest 50, and the count says 51', async () => {
    wire(Array.from({ length: 51 }, (_, i) => order(i)));
    const history = await portalOrders(ctx);
    expect(history.orders).toHaveLength(50);
    expect(history.orders.map((o) => o.id)).not.toContain(order(0).id);
    expect(history.orders[0]?.id).toBe(order(50).id);
    expect(history.total).toBe(51);
  });

  it("counts only this customer's orders in this organization", async () => {
    wire([
      order(1),
      order(2),
      order(3, { customer_id: '44444444-4444-4444-8444-444444444445' }),
      order(4, { organization_id: '00000000-0000-4000-8000-000000000002' }),
    ]);
    const history = await portalOrders(ctx);
    expect(history.orders.map((o) => o.id)).toEqual([order(2).id, order(1).id]);
    expect(history.total).toBe(2);
  });

  it('two orders placed at the same instant: newest first, then by id, so the 50 are always the same 50', async () => {
    const at = '2026-03-01T10:00:00.000Z';
    wire([order(7, { created_at: at }), order(8, { created_at: at })]);
    const history = await portalOrders(ctx);
    expect(history.orders.map((o) => o.id)).toEqual([order(8).id, order(7).id]);
  });

  // Mutation caught: `const { data } = await ...`, which read a failure as
  // "No orders yet".
  it('a failed read throws instead of answering an empty history', async () => {
    adminRef.current = makeSupabaseStub({
      'order_requests.select': { data: null, error: { message: 'canceling statement' } },
    }).client;
    await expect(portalOrders(ctx)).rejects.toThrow();
  });
});
