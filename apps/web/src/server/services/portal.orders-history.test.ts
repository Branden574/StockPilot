import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

/**
 * The B2B portal's "Your orders" (B32). It read the customer's 50 newest
 * orders and said nothing past them, and a read that failed was an empty
 * history: "No orders yet", a claim about the customer's orders made from an
 * error. It now answers the newest PORTAL_ORDERS_SHOWN with the exact count,
 * so the page can say how many it leaves out, and a failed read throws.
 *
 * The count is its own read (integrator decision 4). Asked on the select that
 * embeds each order's lines and item names, `count: 'exact'` is computed apart
 * from the LIMIT, so the limit no longer bounded that read's work. The 50-row
 * read carries no count; a head-only count of order ids with the same filters
 * runs beside it. A count that fails or comes back empty is `total: null` (the
 * page then says nothing about more) and never fails the page; a failed order
 * read still throws.
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

type SelectOpts = { count?: string; head?: boolean };
const selectOf = (call: MockCall) =>
  call.args[call.methods.indexOf('select')] as [string, SelectOpts?] | undefined;
/** The head-only count read (decision 4), told apart from the order read. */
const isCountRead = (call: MockCall) => selectOf(call)?.[1]?.head === true;

/** order_requests as PostgREST answers: the call's filters, order and limit,
 *  and the exact count of the rows they match when the select asks for it
 *  (with no rows for a head-only read). */
function served(rows: Array<Record<string, unknown>>) {
  const serve = servedLikePostgrest(rows);
  return (call: MockCall) => {
    const answer = serve(call);
    const opts = selectOf(call)?.[1];
    if (opts?.count !== 'exact') return answer;
    const keep = call.methods.map((m) => m !== 'limit' && m !== 'range');
    const everything = serve({
      ...call,
      methods: call.methods.filter((_, i) => keep[i]),
      args: call.args.filter((_, i) => keep[i]),
    });
    const count = (everything.data as unknown[]).length;
    return opts.head ? { data: null, error: null, count } : { ...answer, count };
  };
}

function wire(
  rows: Array<Record<string, unknown>>,
  countRead?: (call: MockCall) => { data: unknown; error: { message: string } | null; count?: number | null },
) {
  const answer = served(rows);
  const stub = makeSupabaseStub({
    'order_requests.select': (call) =>
      countRead && isCountRead(call) ? countRead(call) : answer(call),
  });
  adminRef.current = stub.client;
  return stub;
}

/** Every order_requests chain the code started, as [methods, args]. */
function reads(stub: ReturnType<typeof makeSupabaseStub>) {
  const methods = stub.chainsAll.get('order_requests.select') ?? [];
  const args = stub.chainArgsAll.get('order_requests.select') ?? [];
  return methods.map((m, i) => ({ methods: m, args: args[i] ?? [] }));
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

describe('portalOrders: the count is a read of its own (decision 4)', () => {
  const ORDER_SELECT_EMBEDS = 'lines:order_request_lines(';

  // Mutation caught: `{ count: 'exact' }` back on the select that embeds the
  // lines and item names.
  it('the 50-row read that embeds the lines asks for no count, and keeps its limit', async () => {
    const stub = wire(Array.from({ length: 51 }, (_, i) => order(i)));
    await portalOrders(ctx);
    const hydrating = reads(stub).filter((r) =>
      String(r.args[r.methods.indexOf('select')]?.[0]).includes(ORDER_SELECT_EMBEDS),
    );
    expect(hydrating).toHaveLength(1);
    const read = hydrating[0]!;
    expect(read.args[read.methods.indexOf('select')]).toHaveLength(1);
    expect(read.args[read.methods.indexOf('limit')]).toEqual([PORTAL_ORDERS_SHOWN]);
  });

  // Mutation caught: no separate count (the total read from the order read),
  // a count that hydrates rows, or one that drops a filter.
  it('the count is head-only on the order ids, with the same organization and customer filters', async () => {
    const stub = wire(Array.from({ length: 51 }, (_, i) => order(i)));
    const history = await portalOrders(ctx);
    const counts = reads(stub).filter((r) => r.args[r.methods.indexOf('select')]?.[1]);
    expect(counts).toHaveLength(1);
    const count = counts[0]!;
    expect(count.args[count.methods.indexOf('select')]).toEqual([
      'id',
      { count: 'exact', head: true },
    ]);
    const eqs = count.methods
      .map((m, i) => (m === 'eq' ? count.args[i] : null))
      .filter(Boolean);
    expect(eqs).toEqual([
      ['organization_id', ORG],
      ['customer_id', CUSTOMER],
    ]);
    expect(count.methods).not.toContain('limit');
    expect(history.total).toBe(51);
  });

  // Mutation caught: the count awaited after the order read.
  it('the count and the order read run side by side, not one after the other', async () => {
    let countStartedBeforeOrdersAnswered = false;
    const answer = served(Array.from({ length: 3 }, (_, i) => order(i)));
    let started = 0;
    const stub = makeSupabaseStub({
      'order_requests.select': (call) => {
        if (!isCountRead(call)) countStartedBeforeOrdersAnswered = started === 2;
        return answer(call);
      },
    });
    const from = stub.client.from;
    stub.client.from = (table: string) => {
      if (table === 'order_requests') started += 1;
      return from(table);
    };
    adminRef.current = stub.client;
    await portalOrders(ctx);
    expect(countStartedBeforeOrdersAnswered).toBe(true);
  });

  // Mutation caught: a failed count that fails the page, or that answers a
  // made-up total.
  it('a failed count answers total null, and the orders still come back', async () => {
    wire(Array.from({ length: 51 }, (_, i) => order(i)), () => ({
      data: null,
      error: { message: 'canceling statement due to statement timeout' },
      count: null,
    }));
    const history = await portalOrders(ctx);
    expect(history.total).toBeNull();
    expect(history.orders).toHaveLength(50);
  });

  it('a count read that rejects answers total null too, and the orders still come back', async () => {
    const answer = served(Array.from({ length: 2 }, (_, i) => order(i)));
    adminRef.current = makeSupabaseStub({
      'order_requests.select': (call) => {
        if (isCountRead(call)) throw new TypeError('fetch failed');
        return answer(call);
      },
    }).client;
    const history = await portalOrders(ctx);
    expect(history.total).toBeNull();
    expect(history.orders).toHaveLength(2);
  });

  it('a count that comes back without a number answers total null', async () => {
    wire([order(1)], () => ({ data: null, error: null, count: null }));
    expect((await portalOrders(ctx)).total).toBeNull();
  });

  it('a failed order read still throws, even when the count answers', async () => {
    adminRef.current = makeSupabaseStub({
      'order_requests.select': (call) =>
        isCountRead(call)
          ? { data: null, error: null, count: 7 }
          : { data: null, error: { message: 'canceling statement' } },
    }).client;
    await expect(portalOrders(ctx)).rejects.toThrow();
  });
});
