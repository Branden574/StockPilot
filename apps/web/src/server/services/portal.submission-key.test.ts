import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Portal Place order is placed once per submission key.
 *
 * portalSubmitOrder sends the customer's key to the database with the
 * identity it takes from the portal context (never from the input):
 * portal_order_submission_status first, before the catalog checks that change
 * over time, then place_portal_order_request. The database (pgTAP:
 * supabase/tests/portal_order_submission_key.test.sql) decides; the stand-in
 * below keeps its rule, a row per (organization, user, key) holding the
 * customer and the cart, so these tests prove what the service sends, in what
 * order, and what the customer is told.
 */

type Row = Record<string, unknown>;

const { adminRef, dispatchEvent, reportError } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  dispatchEvent: vi.fn(async () => {}),
  reportError: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent }));
vi.mock('@/server/services/returns', () => ({
  pendingReturnQuantitiesByLine: vi.fn(async () => new Map<string, number>()),
}));

import { ServiceError } from './context';
import {
  PORTAL_ORDER_CONFLICT_COPY,
  PORTAL_ORDER_KEY_COPY,
  PORTAL_ORDER_UNCONFIRMED_COPY,
  portalSubmitOrder,
  type PortalContext,
} from './portal';

const ORG_X = '00000000-0000-4000-8000-00000000000a';
const ORG_Y = '00000000-0000-4000-8000-00000000000b';
const CUSTOMER_A = '44444444-4444-4444-8444-44444444444a';
const CUSTOMER_A2 = '44444444-4444-4444-8444-4444444444a2';
const CUSTOMER_C = '44444444-4444-4444-8444-44444444444c';
const CUSTOMER_B = '44444444-4444-4444-8444-44444444444b';
const WAREHOUSE_X = '66666666-6666-4666-8666-66666666666a';
const WAREHOUSE_Y = '66666666-6666-4666-8666-66666666666b';
const ITEM_1 = '11111111-1111-4111-8111-111111111111';
const ITEM_2 = '22222222-2222-4222-8222-222222222222';
const ITEM_Y = '33333333-3333-4333-8333-333333333333';
const KEY = 'a7e19000-0000-4000-8000-000000000001';
const KEY_2 = 'a7e19000-0000-4000-8000-000000000002';

function ctx(over: Partial<PortalContext> = {}): PortalContext {
  return {
    userId: 'aaaaaaaa-0000-4000-8000-0000000000a1',
    email: 'office@harbor.example.org',
    customerId: CUSTOMER_A,
    customerName: 'Harbor Elementary',
    organizationId: ORG_X,
    orgName: 'Northside Supply',
    orgLogoUrl: null,
    priceListId: null,
    pricingMode: 'no_charge',
    ...over,
  };
}
const CTX_A = ctx();
/** Another customer's user in the same organization. */
const CTX_C = ctx({ userId: 'aaaaaaaa-0000-4000-8000-0000000000c1', customerId: CUSTOMER_C });
/** Customer A's user, signed in under another customer of the organization. */
const CTX_A2 = ctx({ customerId: CUSTOMER_A2 });
/** A customer of another organization. */
const CTX_B = ctx({
  userId: 'aaaaaaaa-0000-4000-8000-0000000000b1',
  customerId: CUSTOMER_B,
  organizationId: ORG_Y,
});

interface Db {
  inventory_items: Row[];
  customer_catalog: Row[];
  /** (organization|user|key) → the row the database keeps. */
  submissions: Map<string, { customer: string; cart: string; orderId: string }>;
  orders: Row[];
}

function makeDb(): Db {
  const item = (id: string, org: string, wh: string): Row => ({
    id,
    organization_id: org,
    warehouse_id: wh,
    name: `Item ${id.slice(0, 4)}`,
    sku: `SKU-${id.slice(0, 4)}`,
    quantity_on_hand: 20,
    unit_cost: 3,
    is_bundle: false,
    status: 'active',
    awaiting_first_receipt: false,
    deleted_at: null,
    order_catalog_visible: true,
  });
  return {
    inventory_items: [
      item(ITEM_1, ORG_X, WAREHOUSE_X),
      item(ITEM_2, ORG_X, WAREHOUSE_X),
      item(ITEM_Y, ORG_Y, WAREHOUSE_Y),
    ],
    customer_catalog: [CUSTOMER_A, CUSTOMER_A2, CUSTOMER_C]
      .flatMap((c) => [ITEM_1, ITEM_2].map((i) => ({ customer_id: c, item_id: i })))
      .concat([{ customer_id: CUSTOMER_B, item_id: ITEM_Y }]),
    submissions: new Map(),
    orders: [],
  };
}

type RpcError = { message: string; code?: string; hint?: string; details?: string };

/**
 * An admin client whose reads apply the service's own filters, and whose two
 * key functions keep the database's rule: a row per (organization, user,
 * key); the same customer and cart replays the order, anything else under
 * the key is idempotency_conflict with no detail.
 */
function makeAdmin(db: Db, rpcErrors: Record<string, RpcError[]> = {}) {
  const calls: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];

  function chain(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let window: [number, number] | null = null;
    const rows = () => {
      const all = ((db as unknown as Record<string, Row[]>)[table] ?? []).filter((r) =>
        preds.every((p) => p(r)),
      );
      return window ? all.slice(window[0], window[1] + 1) : all;
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
      order: () => b,
      range: (f: number, t: number) => ((window = [f, t]), b),
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: rows(), error: null }),
    };
    return b;
  }

  function cartOf(args: Row): string {
    const h = args.p_header as Row;
    const sums = new Map<string, number>();
    for (const l of args.p_lines as Row[]) {
      const id = String(l.item_id);
      sums.set(id, (sums.get(id) ?? 0) + Number(l.quantity_requested));
    }
    return JSON.stringify([h.notes ?? null, [...sums.entries()].sort()]);
  }
  function lookup(args: Row): { data: Row | null; error: RpcError | null } {
    const h = args.p_header as Row;
    if (typeof args.p_key !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.p_key)) {
      return {
        data: null,
        error: {
          message: 'idempotency_key_invalid',
          code: '22023',
          hint: 'idempotency_key_invalid',
        },
      };
    }
    const row = db.submissions.get(`${h.organization_id}|${h.requester_user_id}|${args.p_key}`);
    if (!row) return { data: { outcome: 'none' }, error: null };
    if (row.customer !== h.customer_id || row.cart !== cartOf(args)) {
      return {
        data: null,
        error: { message: 'idempotency_conflict', code: 'P0001', hint: 'idempotency_conflict' },
      };
    }
    return { data: { outcome: 'placed', replay: true, order_id: row.orderId }, error: null };
  }

  return {
    calls,
    rpcCalls,
    client: {
      from: (table: string) => {
        calls.push(`from:${table}`);
        return chain(table);
      },
      rpc: async (fn: string, args: Row) => {
        calls.push(`rpc:${fn}`);
        rpcCalls.push({ fn, args });
        const queued = rpcErrors[fn]?.shift();
        if (queued) return { data: null, error: queued };
        if (fn === 'portal_order_submission_status') return lookup(args);
        if (fn === 'place_portal_order_request') {
          const seen = lookup(args);
          if (seen.error || seen.data?.outcome === 'placed') return seen;
          const h = args.p_header as Row;
          const orderId = `9${String(db.orders.length + 1).padStart(7, '0')}-0000-4000-8000-000000000000`;
          db.orders.push({ id: orderId, ...h, lines: args.p_lines });
          db.submissions.set(`${h.organization_id}|${h.requester_user_id}|${args.p_key}`, {
            customer: String(h.customer_id),
            cart: cartOf(args),
            orderId,
          });
          return { data: { outcome: 'placed', replay: false, order_id: orderId }, error: null };
        }
        return { data: null, error: { message: `no such function ${fn}` } };
      },
    },
  };
}

let db: Db;
let admin: ReturnType<typeof makeAdmin>;
beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  admin = makeAdmin(db);
  adminRef.current = admin.client;
});

const CART = {
  lines: [
    { itemId: ITEM_1, quantity: 2 },
    { itemId: ITEM_2, quantity: 1 },
  ],
  notes: 'Leave at the front desk',
};

describe('the portal submission key', () => {
  it('a submit without a key is refused before anything is read or written', async () => {
    const input = { ...CART } as unknown as Parameters<typeof portalSubmitOrder>[1];
    await expect(portalSubmitOrder(CTX_A, input)).rejects.toMatchObject({
      code: 'validation_error',
      message: PORTAL_ORDER_KEY_COPY,
    });
    await expect(
      portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: 'not-a-key' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: PORTAL_ORDER_KEY_COPY,
    });
    expect(admin.calls).toEqual([]);
    expect(db.orders).toHaveLength(0);
  });

  it('asks the key first, then places through place_portal_order_request with the key and the context identity', async () => {
    const placed = await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    expect(placed).toEqual({ id: db.orders[0]!.id, replay: false });
    // The key is read before the catalog, and the order is written last.
    expect(admin.calls[0]).toBe('rpc:portal_order_submission_status');
    expect(admin.calls.at(-1)).toBe('rpc:place_portal_order_request');
    expect(admin.calls).not.toContain('rpc:insert_order_request_with_lines');
    const status = admin.rpcCalls.find((c) => c.fn === 'portal_order_submission_status')!;
    const place = admin.rpcCalls.find((c) => c.fn === 'place_portal_order_request')!;
    expect(status.args.p_key).toBe(KEY);
    expect(place.args.p_key).toBe(KEY);
    expect(status.args.p_header).toEqual({
      organization_id: ORG_X,
      customer_id: CUSTOMER_A,
      requester_user_id: CTX_A.userId,
      source: 'portal',
      notes: 'Leave at the front desk',
    });
    expect(place.args.p_header).toMatchObject({
      organization_id: ORG_X,
      customer_id: CUSTOMER_A,
      requester_user_id: CTX_A.userId,
      source: 'portal',
      status: 'pending_approval',
      warehouse_id: WAREHOUSE_X,
      notes: 'Leave at the front desk',
    });
    // The status read and the write name the same cart: one line per item, in item order.
    expect(status.args.p_lines).toEqual([
      { item_id: ITEM_1, quantity_requested: 2 },
      { item_id: ITEM_2, quantity_requested: 1 },
    ]);
    expect((place.args.p_lines as Row[]).map((l) => [l.item_id, l.quantity_requested])).toEqual([
      [ITEM_1, 2],
      [ITEM_2, 1],
    ]);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('a resend after a lost answer returns the first order and creates nothing, even after the catalog changed', async () => {
    const first = await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    // The item is hidden after the first call: a fresh submit would be refused.
    db.inventory_items.find((r) => r.id === ITEM_1)!.order_catalog_visible = false;
    admin.calls.length = 0;
    const again = await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    expect(again).toEqual({ id: first.id, replay: true });
    expect(db.orders).toHaveLength(1);
    // Answered from the key alone: no catalog read, no write, no second event.
    expect(admin.calls).toEqual(['rpc:portal_order_submission_status']);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('a replay the write itself answers (two sends crossing) sends no second event', async () => {
    await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    // The second send's status read ran before the first send committed, so
    // it answered none; the write, under the key's lock, answers the replay.
    adminRef.current = {
      ...admin.client,
      rpc: async (fn: string, args: Row) =>
        fn === 'portal_order_submission_status'
          ? { data: { outcome: 'none' }, error: null }
          : admin.client.rpc(fn, args),
    };
    const again = await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    expect(again).toEqual({ id: db.orders[0]!.id, replay: true });
    expect(db.orders).toHaveLength(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("a key from another customer or organization never matches or reveals another customer's order", async () => {
    const a = await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });

    // Another customer of the same organization, same key, same cart: its own order.
    const c = await portalSubmitOrder(CTX_C, { ...CART, idempotencyKey: KEY });
    expect(c.replay).toBe(false);
    expect(c.id).not.toBe(a.id);
    expect(db.orders.find((o) => o.id === c.id)).toMatchObject({ customer_id: CUSTOMER_C });

    // A customer of another organization, same key: its own order there.
    const b = await portalSubmitOrder(CTX_B, {
      lines: [{ itemId: ITEM_Y, quantity: 2 }],
      notes: 'Leave at the front desk',
      idempotencyKey: KEY,
    });
    expect(b.replay).toBe(false);
    expect(db.orders.find((o) => o.id === b.id)).toMatchObject({
      organization_id: ORG_Y,
      customer_id: CUSTOMER_B,
    });

    // The same user under another customer of the organization: refused, and
    // the answer names no order.
    const refused = await portalSubmitOrder(CTX_A2, { ...CART, idempotencyKey: KEY }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ServiceError);
    expect(refused).toMatchObject({ code: 'conflict', message: PORTAL_ORDER_CONFLICT_COPY });
    const told = JSON.stringify({
      message: (refused as ServiceError).message,
      details: (refused as ServiceError).details ?? null,
    });
    for (const o of db.orders) {
      expect(told).not.toContain(String(o.id));
      expect(told).not.toContain(String(o.id).slice(0, 8).toUpperCase());
    }
    expect(db.orders.filter((o) => o.customer_id === CUSTOMER_A2)).toHaveLength(0);

    // Identity rides on the context only: a crafted input cannot name another customer.
    const crafted = {
      ...CART,
      idempotencyKey: KEY_2,
      customerId: CUSTOMER_C,
      organizationId: ORG_Y,
      userId: CTX_C.userId,
    } as unknown as Parameters<typeof portalSubmitOrder>[1];
    const own = await portalSubmitOrder(CTX_A, crafted);
    expect(db.orders.find((o) => o.id === own.id)).toMatchObject({
      organization_id: ORG_X,
      customer_id: CUSTOMER_A,
      requester_user_id: CTX_A.userId,
    });
  });

  it('the same key with another cart is refused with the conflict sentence and places nothing', async () => {
    await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    await expect(
      portalSubmitOrder(CTX_A, {
        ...CART,
        lines: [{ itemId: ITEM_1, quantity: 3 }],
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: PORTAL_ORDER_CONFLICT_COPY });
    expect(db.orders).toHaveLength(1);
  });

  it('the conflict for the same account under another customer does not say "different items" and names no order', async () => {
    await portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
    const e = (await portalSubmitOrder(CTX_A2, { ...CART, idempotencyKey: KEY }).catch(
      (x: unknown) => x,
    )) as ServiceError;
    expect(e.message).toBe(PORTAL_ORDER_CONFLICT_COPY);
    expect(e.message).not.toMatch(/different items/i);
    expect(e.details).toEqual({ outcome: 'refused' });
  });
});

/**
 * What each failure means for the cart, class by class (the `outcome` in the
 * refusal's details, which the portal shop reads):
 *   refused  definite: nothing was placed and this cart as sent will not be;
 *   unknown  the keyed write may have committed: the cart stays as sent;
 *   (none)   a read failed before anything was written.
 */
describe('Place order failures, class by class', () => {
  async function failure(run: () => Promise<unknown>): Promise<ServiceError> {
    const e = await run().then(
      () => {
        throw new Error('expected a refusal');
      },
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ServiceError);
    return e as ServiceError;
  }
  const send = () => portalSubmitOrder(CTX_A, { ...CART, idempotencyKey: KEY });
  function writeAnswers(answer: (args: Row) => Promise<unknown>) {
    admin = makeAdmin(db);
    const inner = admin.client;
    adminRef.current = {
      ...inner,
      rpc: async (fn: string, args: Row) =>
        fn === 'place_portal_order_request' ? answer(args) : inner.rpc(fn, args),
    };
  }

  it.each([
    [
      'an item hidden by the ordering gate',
      { message: 'hidden', code: 'P0001', hint: 'order_item_hidden' },
      'validation_error',
      'One of the items is no longer available to order.',
    ],
    [
      'a line above the ceiling',
      { message: 'too large', code: '22023', hint: 'order_lines_invalid' },
      'validation_error',
      'A line can have at most 10,000 units.',
    ],
    [
      'a key held by another submission',
      { message: 'idempotency_conflict', code: 'P0001', hint: 'idempotency_conflict' },
      'conflict',
      PORTAL_ORDER_CONFLICT_COPY,
    ],
    [
      'a key the database refuses',
      { message: 'idempotency_key_invalid', code: '22023', hint: 'idempotency_key_invalid' },
      'validation_error',
      PORTAL_ORDER_KEY_COPY,
    ],
    [
      'a header the service built wrong',
      { message: 'order_request_invalid', code: '22023', hint: 'order_request_invalid' },
      'validation_error',
      'Order could not be submitted. Please try again.',
    ],
  ])(
    'the write raises %s: refused (definite), nothing placed',
    async (_label, error, code, message) => {
      admin = makeAdmin(db, { place_portal_order_request: [error as RpcError] });
      adminRef.current = admin.client;
      const e = await failure(send);
      expect(e).toMatchObject({ code, message });
      expect(e.details).toEqual({ outcome: 'refused' });
      expect(db.orders).toHaveLength(0);
      expect(dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'no SQLSTATE: the fetch to the database failed',
      { message: 'TypeError: fetch failed', code: '' },
      true,
    ],
    ['a dropped connection (08006)', { message: 'connection reset', code: '08006' }, true],
    [
      'a gateway or server error (PGRST000, 503)',
      { message: 'Service Unavailable', code: 'PGRST000' },
      true,
    ],
    ['an internal error (XX000)', { message: 'internal', code: 'XX000' }, true],
    [
      'the key lock held by an earlier send (55P03)',
      { message: 'lock timeout', code: '55P03' },
      false,
    ],
    ['a statement timeout (57014)', { message: 'canceling statement', code: '57014' }, false],
    ['a deadlock (40P01)', { message: 'deadlock detected', code: '40P01' }, false],
  ])('the write answers %s: unknown, the cart stays as sent', async (_label, error, reported) => {
    admin = makeAdmin(db, { place_portal_order_request: [error as RpcError] });
    adminRef.current = admin.client;
    const e = await failure(send);
    expect(e).toMatchObject({ code: 'conflict', message: PORTAL_ORDER_UNCONFIRMED_COPY });
    expect(e.details).toEqual({ outcome: 'unknown', retryable: true });
    expect(reportError).toHaveBeenCalledTimes(reported ? 1 : 0);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('the write answers no order: unknown', async () => {
    writeAnswers(async () => ({ data: { outcome: 'placed' }, error: null }));
    const e = await failure(send);
    expect(e.details).toEqual({ outcome: 'unknown', retryable: true });
    expect(e.message).toBe(PORTAL_ORDER_UNCONFIRMED_COPY);
  });

  it('the write call throws instead of answering: unknown', async () => {
    writeAnswers(async () => {
      throw new TypeError('fetch failed');
    });
    const e = await failure(send);
    expect(e.details).toEqual({ outcome: 'unknown', retryable: true });
    expect(e.message).toBe(PORTAL_ORDER_UNCONFIRMED_COPY);
  });

  it('an unknown write is settled by the same cart under the same key: the order the write committed', async () => {
    // The write commits, then its answer is lost.
    let lost = true;
    admin = makeAdmin(db);
    const inner = admin.client;
    adminRef.current = {
      ...inner,
      rpc: async (fn: string, args: Row) => {
        const answer = await inner.rpc(fn, args);
        if (fn === 'place_portal_order_request' && lost) {
          lost = false;
          return { data: null, error: { message: 'TypeError: fetch failed', code: '' } };
        }
        return answer;
      },
    };
    const e = await failure(send);
    expect(e.details).toMatchObject({ outcome: 'unknown' });
    expect(db.orders).toHaveLength(1);
    expect(await send()).toEqual({ id: db.orders[0]!.id, replay: true });
    expect(db.orders).toHaveLength(1);
  });

  it('the key read fails: no outcome (a read; nothing was written), reported', async () => {
    admin = makeAdmin(db, {
      portal_order_submission_status: [{ message: 'connection reset', code: '08006' }],
    });
    adminRef.current = admin.client;
    const e = await failure(send);
    expect(e).toMatchObject({
      code: 'validation_error',
      message: 'Order could not be submitted. Please try again.',
    });
    expect(e.details).toBeUndefined();
    expect(admin.calls).toEqual(['rpc:portal_order_submission_status']);
    expect(db.orders).toHaveLength(0);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('the key read raises a conflict: refused (definite)', async () => {
    admin = makeAdmin(db, {
      portal_order_submission_status: [
        { message: 'idempotency_conflict', code: 'P0001', hint: 'idempotency_conflict' },
      ],
    });
    adminRef.current = admin.client;
    const e = await failure(send);
    expect(e).toMatchObject({ code: 'conflict', message: PORTAL_ORDER_CONFLICT_COPY });
    expect(e.details).toEqual({ outcome: 'refused' });
  });

  it('the catalog cannot be read: no outcome (a read; nothing was written)', async () => {
    // Every table read answers the way PostgREST reports a failed request.
    adminRef.current = {
      ...admin.client,
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'is', 'order', 'range']) b[m] = () => b;
        b.then = (resolve: (v: { data: null; error: { message: string } }) => void) =>
          resolve({ data: null, error: { message: 'network down' } });
        return b;
      },
    };
    const e = await failure(send);
    expect(e.details?.outcome).toBeUndefined();
    expect(db.orders).toHaveLength(0);
  });

  it.each([
    [
      'no key',
      { ...CART } as unknown as Parameters<typeof portalSubmitOrder>[1],
      PORTAL_ORDER_KEY_COPY,
    ],
    [
      'a line above 10,000 units',
      { lines: [{ itemId: ITEM_1, quantity: 10_001 }], idempotencyKey: KEY },
      'A line can have at most 10,000 units.',
    ],
    [
      'an item off the customer catalog',
      { lines: [{ itemId: ITEM_Y, quantity: 1 }], idempotencyKey: KEY },
      'One of the items is no longer available to order.',
    ],
  ])(
    'the service refuses %s before writing: refused (definite)',
    async (_label, input, message) => {
      const e = await failure(() => portalSubmitOrder(CTX_A, input));
      expect(e).toMatchObject({ code: 'validation_error', message });
      expect(e.details).toEqual({ outcome: 'refused' });
      expect(admin.calls).not.toContain('rpc:place_portal_order_request');
    },
  );
});
