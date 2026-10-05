import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  ORDER_WAREHOUSE_WRITE_REFUSED_COPY,
  type ModuleId,
  type Role,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));
const adminHandle: { client: unknown } = { client: null };

import { ServiceError } from './context';
import { OrderRequestsService } from './order-requests';

/**
 * Small fixes slice 2, review of the test stage (2026-10-05). The order
 * service refuses a change to an order outside the caller's warehouses with
 * ONE sentence on every path (core ORDER_WAREHOUSE_WRITE_REFUSED_COPY), and a
 * failed read of the caller's own access with another
 * (ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY), never a warehouse id:
 *
 *   - Cancel by an approver now asks write access to the order's warehouse,
 *     as Approve, Deny and every other approver action already did (an
 *     approver assigned to warehouse A could cancel a warehouse B order from
 *     the order page). The person who placed it still cancels it while it
 *     waits for approval, with no warehouse check: that is the requester's
 *     cancel, which a viewer may make.
 *   - Adding, changing and removing lines answered "User does not have read
 *     access to warehouse <uuid>." (loadEditableOrderHeader's own check).
 *   - A staff member whose assignments could not be read was told they do not
 *     work in the warehouse, even for their own.
 *
 * These run the REAL warehouse helpers (lib/auth/warehouse) against the stub:
 * staff assigned to wh-a only, the order in wh-b unless a test says otherwise.
 */

const FAILED: QueryResult = {
  data: null,
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
};

function access(opts: { assignments?: QueryResult } = {}): Record<string, QueryResult> {
  return {
    'user_warehouse_assignments.select': opts.assignments ?? {
      data: [{ warehouse_id: 'wh-a', is_primary: true }],
      error: null,
    },
    'organization_members.select.maybeSingle': { data: { all_warehouses: false }, error: null },
  };
}

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string; permissions?: string[] } = {},
) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'staff',
      userId: opts.userId ?? 'appr-1',
      enabledModules: new Set<ModuleId>(['orders']),
      permissions: new Set(opts.permissions ?? ['orders:request', 'orders:approve', 'items:update']),
    }),
  );
}

const CANCELLED = {
  'rpc:cancel_order_request': { data: { id: 'ord-1', status: 'cancelled', order_number: 8 }, error: null },
};

function order(over: Record<string, unknown> = {}) {
  return {
    'order_requests.select': {
      data: {
        id: 'ord-1',
        status: 'approved',
        warehouse_id: 'wh-b',
        requester_user_id: 'someone-else',
        pick_slip_generated_at: null,
        order_number: 8,
        ...over,
      },
      error: null,
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<Error & { code?: string; details?: Record<string, unknown> }> {
  const e = await p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (x: unknown) => x,
  );
  return e as Error & { code?: string };
}

beforeEach(() => vi.clearAllMocks());

describe('cancel by an approver asks write access to the order\'s warehouse', () => {
  it("refuses a staff approver on another warehouse's order in the one sentence, before the function", async () => {
    const stub = makeSupabaseStub({ ...order(), ...access(), ...CANCELLED });
    const e = await refusal(svc(stub).cancel('ord-1', null));
    expect(e.name).toBe('ForbiddenError');
    expect(e.message).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it("lets a staff approver cancel an order in their own warehouse", async () => {
    const stub = makeSupabaseStub({ ...order({ warehouse_id: 'wh-a' }), ...access(), ...CANCELLED });
    await svc(stub).cancel('ord-1', null);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
  });

  it('lets the person who placed it cancel it while it waits for approval, wherever it is (the requester\'s cancel)', async () => {
    const stub = makeSupabaseStub({
      ...order({ status: 'pending_approval', requester_user_id: 'appr-1' }),
      ...access(),
      ...CANCELLED,
    });
    await svc(stub).cancel('ord-1', null);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    // Decided without reading the caller's warehouses.
    expect(stub.fromCalls).not.toContain('user_warehouse_assignments');
  });

  it('refuses the same approver on their own order once it is approved (an approver\'s cancel then)', async () => {
    const stub = makeSupabaseStub({ ...order({ requester_user_id: 'appr-1' }), ...access(), ...CANCELLED });
    const e = await refusal(svc(stub).cancel('ord-1', null));
    expect(e.message).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('keeps the read-only refusal for a viewer granted orders:approve on someone else\'s order', async () => {
    const stub = makeSupabaseStub({ ...order({ warehouse_id: 'wh-a' }), ...access(), ...CANCELLED });
    const e = await refusal(svc(stub, { role: 'viewer' }).cancel('ord-1', null));
    expect(e.message).toBe('Read-only auditor cannot perform write operations.');
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('says the access could not be checked when the assignments read failed, and changes nothing', async () => {
    const stub = makeSupabaseStub({
      ...order({ warehouse_id: 'wh-a' }),
      ...access({ assignments: FAILED }),
      ...CANCELLED,
    });
    const e = await refusal(svc(stub).cancel('ord-1', null));
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'conflict', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses when the order read itself fails, before the function (never decides on a read that did not happen)', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': FAILED, ...access(), ...CANCELLED });
    await expect(svc(stub).cancel('ord-1', null)).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a manager is not read at all: the role works in every warehouse', async () => {
    const stub = makeSupabaseStub({ ...CANCELLED });
    await svc(stub, { role: 'manager', userId: 'mgr-1' }).cancel('ord-1', null);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    expect(stub.fromCalls).not.toContain('order_requests');
  });
});

describe('adding, changing and removing items: the same sentence, never the warehouse id', () => {
  const line = {
    'order_request_lines.select': {
      data: { id: 'line-1', item_id: 'item-1', quantity_requested: 10, quantity_fulfilled: 0, quantity_picked: null, returned_quantity: 0 },
      error: null,
    },
  };

  it.each([
    ['addLines', (s: OrderRequestsService) => s.addLines('ord-1', [{ itemId: 'item-1', quantity: 2 }])],
    ['updateLineQuantity', (s: OrderRequestsService) => s.updateLineQuantity('ord-1', 'line-1', 4)],
    ['removeLine', (s: OrderRequestsService) => s.removeLine('ord-1', 'line-1')],
  ] as const)('%s by a staff approver on another warehouse\'s order', async (_name, run) => {
    const stub = makeSupabaseStub({ ...order(), ...access(), ...line });
    const e = await refusal(run(svc(stub)));
    expect(e.name).toBe('ForbiddenError');
    expect(e.message).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
    expect(e.message).not.toMatch(/wh-b|access to warehouse/);
    expect(stub.chains.get('order_request_lines.update')).toBeUndefined();
    expect(stub.chains.get('order_request_lines.delete')).toBeUndefined();
    expect(stub.chains.get('order_request_lines.insert')).toBeUndefined();
  });

  it('says the access could not be checked when the assignments read failed', async () => {
    const stub = makeSupabaseStub({ ...order({ warehouse_id: 'wh-a' }), ...access({ assignments: FAILED }), ...line });
    const e = await refusal(svc(stub).updateLineQuantity('ord-1', 'line-1', 4));
    expect(e).toMatchObject({ code: 'conflict', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY });
    expect(stub.chains.get('order_request_lines.update')).toBeUndefined();
  });
});

describe('every other approver action: a failed access read is not "a warehouse you don\'t work in"', () => {
  it('Approve on an order in their own warehouse, with the assignments read failing: the retry sentence', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
      ...access({ assignments: FAILED }),
    });
    const e = await refusal(svc(stub).approve('ord-1', null));
    expect(e).toMatchObject({ code: 'conflict', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('Approve on another warehouse\'s order with the access read fine: the one sentence', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-b' }, error: null },
      ...access(),
    });
    const e = await refusal(svc(stub).approve('ord-1', null));
    expect(e.name).toBe('ForbiddenError');
    expect(e.message).toBe(ORDER_WAREHOUSE_WRITE_REFUSED_COPY);
  });
});

describe('Hold available stock and the needed-by date say the same sentence (one rule, one answer)', () => {
  it('Hold: a staff approver outside the warehouse', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-b' }, error: null },
      ...access(),
    });
    const e = await refusal(svc(stub).holdStock('ord-1'));
    expect(e).toBeInstanceOf(ServiceError);
    expect(e).toMatchObject({ code: 'forbidden', message: ORDER_WAREHOUSE_WRITE_REFUSED_COPY, details: { reason: 'forbidden' } });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('Hold: the access could not be read', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-a' }, error: null },
      ...access({ assignments: FAILED }),
    });
    const e = await refusal(svc(stub).holdStock('ord-1'));
    expect(e).toMatchObject({ code: 'conflict', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  const revise = (s: OrderRequestsService) =>
    s.reviseNeededBy({
      id: 'ord-1',
      neededByLocal: '2026-10-20T10:00',
      expectedNeededBy: null,
      reason: 'Moved by the school',
    });
  const neededByOrder = (wh: string) => ({
    'order_requests.select.maybeSingle': {
      data: {
        id: 'ord-1',
        organization_id: 'org-test',
        warehouse_id: wh,
        status: 'approved',
        needed_by: null,
        order_number: 8,
        fulfillment_type: 'pickup',
        requester_name: 'Doua Vang',
        assigned_delivery_user_id: null,
      },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { timezone: 'America/Los_Angeles' }, error: null },
  });

  it('Needed-by: a staff approver outside the warehouse', async () => {
    const stub = makeSupabaseStub({ ...neededByOrder('wh-b'), ...access() });
    const e = await refusal(revise(svc(stub)));
    expect(e).toMatchObject({ code: 'forbidden', message: ORDER_WAREHOUSE_WRITE_REFUSED_COPY, details: { reason: 'forbidden' } });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('Needed-by: the access could not be read (retryable, nothing changed)', async () => {
    const stub = makeSupabaseStub({ ...neededByOrder('wh-a'), ...access({ assignments: FAILED }) });
    const e = await refusal(revise(svc(stub)));
    expect(e).toMatchObject({
      code: 'conflict',
      message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
      details: { reason: 'failed', retryable: true },
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});
