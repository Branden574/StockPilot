import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * The exchange replacement order on the order paths (returns RX-2, plan
 * 3.6.9 and 3.3.8): the database's refusals mapped by hint into core's words
 * (never internal_error), the fixed lines refused before any write, the
 * prepare chain (skips what is done, stops at the first refusal, never
 * signs) and the orders list's chip from one batched read.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(), getWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));

import { OrderRequestsService } from './order-requests';

const ORDER = 'ord-1';
const RMA = 'rma-1';

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer'; userId?: string; permissions?: ReadonlySet<string> } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      userId: opts.userId ?? 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders', 'returns']),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  );
}

const gateError = (hint: string) => ({ data: null, error: { code: 'P0001', hint, message: hint } });

beforeEach(() => vi.clearAllMocks());

describe('the replacement refusals are mapped by hint (plan 3.6.9)', () => {
  it('generatePickSlip at the return-first gate says "Waiting for the returned item." (409), not internal_error', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1', status: 'approved' }, error: null },
      'order_requests.update.maybeSingle': gateError('replacement_waiting_for_return'),
    });
    await expect(svc(stub).generatePickSlip(ORDER)).rejects.toMatchObject({
      code: 'conflict',
      message: 'Waiting for the returned item.',
      details: { reason: 'replacement_waiting_for_return' },
    });
  });

  it('cancel by an approver meets the cancel guard: "Change or cancel this replacement from its RMA."', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:cancel_order_request': gateError('replacement_cancel_via_return'),
    });
    await expect(svc(stub).cancel(ORDER, 'nope')).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'replacement_cancel_via_return' },
    });
  });

  it('cancel by the requester is refused before the call, in the same words', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { status: 'approved', requester_user_id: 'req-1', replacement_for_return_id: RMA },
        error: null,
      },
    });
    const requester = svc(stub, { role: 'staff', userId: 'req-1', permissions: new Set(['orders:request']) });
    await expect(requester.cancel(ORDER)).rejects.toMatchObject({ details: { reason: 'replacement_cancel_via_return' } });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('resumeFulfillment of a gated backordered replacement says it waits', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:resume_fulfillment': gateError('replacement_waiting_for_return'),
    });
    await expect(svc(stub).resumeFulfillment(ORDER)).rejects.toMatchObject({ details: { reason: 'replacement_waiting_for_return' } });
  });

  it('an ordinary order keeps its old words (no hint, no replacement mapping)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:cancel_order_request': { data: null, error: { code: 'P0001', message: 'invalid_status_transition' } },
    });
    await expect(svc(stub).cancel(ORDER)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'This request can no longer be cancelled',
    });
  });
});

describe('a replacement order\'s lines are fixed (loadEditableOrderHeader)', () => {
  const header = {
    id: ORDER,
    status: 'approved',
    warehouse_id: 'wh-1',
    requester_user_id: 'req-1',
    pick_slip_generated_at: null,
    order_number: 104,
    replacement_for_return_id: RMA,
  };

  it.each([
    ['addLines', (s: OrderRequestsService) => s.addLines(ORDER, [{ itemId: 'i1', quantity: 1 }])],
    ['updateLineQuantity', (s: OrderRequestsService) => s.updateLineQuantity(ORDER, 'line-1', 2)],
    ['removeLine', (s: OrderRequestsService) => s.removeLine(ORDER, 'line-1')],
  ] as const)('%s is refused with replacement_lines_fixed before any write', async (_name, call) => {
    const stub = makeSupabaseStub({ 'order_requests.select.maybeSingle': { data: header, error: null } });
    await expect(call(svc(stub))).rejects.toMatchObject({
      code: 'forbidden',
      message: "A replacement's items come from its RMA and can't be edited here.",
      details: { reason: 'replacement_lines_fixed' },
    });
    expect(stub.chains.has('order_request_lines.insert')).toBe(false);
    expect(stub.chains.has('order_request_lines.update')).toBe(false);
    expect(stub.chains.has('order_request_lines.delete')).toBe(false);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an ordinary order is not refused by the replacement rule', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { ...header, replacement_for_return_id: null, status: 'completed' }, error: null },
    });
    // The ordinary ship gate answers instead (completed: no longer changed).
    await expect(svc(stub).removeLine(ORDER, 'line-1')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('prepareForHandover (plan 3.3.8)', () => {
  /** One order whose status the step mocks move on. */
  function chain(initial: string, opts: { fulfillment?: 'pickup' | 'delivery'; picker?: string | null; refuse?: Record<string, string> } = {}) {
    const state = { status: initial };
    const refuse = opts.refuse ?? {};
    const row = () => ({
      id: ORDER,
      warehouse_id: 'wh-1',
      status: state.status,
      fulfillment_type: opts.fulfillment ?? 'pickup',
      assigned_picker_id: opts.picker ?? null,
      picking_completed_at: null,
      order_number: 104,
    });
    const stub = makeSupabaseStub({
      'order_requests.select': () => ({ data: [row()], error: null }),
      'order_requests.update': (call: MockCall) => {
        const payload = call.args[call.methods.indexOf('update')]?.[0] as { status: string };
        if (payload.status === 'pick_slip_generated' && refuse.pick_slip) return gateError(refuse.pick_slip);
        state.status = payload.status;
        return { data: [row()], error: null };
      },
      'order_request_lines.select': { data: null, error: null, count: 0 },
      'rpc:claim_picking': () => {
        state.status = 'picking_in_progress';
        return { data: row(), error: null };
      },
      'rpc:complete_picking': () => {
        if (refuse.pick) return { data: null, error: { code: 'P0001', message: refuse.pick } };
        state.status = 'picking_complete';
        return { data: row(), error: null };
      },
      'rpc:generate_order_packing_slips': () => {
        state.status = 'packing_slip_generated';
        return { data: row(), error: null };
      },
    } as never);
    return { stub, state };
  }

  it('from approved: pick slip, pick, packing slips, staged for pickup; a manager claims nothing; it never signs', async () => {
    const { stub, state } = chain('approved');
    const out = await svc(stub).prepareForHandover(ORDER, { stopAt: 'staged' });
    expect(out.ran).toEqual([
      { step: 'pick_slip', outcome: 'done' },
      { step: 'pick', outcome: 'done' },
      { step: 'packing_slips', outcome: 'done' },
      { step: 'stage', outcome: 'done' },
    ]);
    expect(state.status).toBe('staged_for_pickup');
    expect(out).toMatchObject({ status: 'staged_for_pickup', fulfillmentType: 'pickup' });
    const rpcs = stub.rpcCalls.map((c) => c.name);
    expect(rpcs).toEqual(['complete_picking', 'generate_order_packing_slips']);
    expect(rpcs.some((n) => /signature|sign/.test(n))).toBe(false);
  });

  it('a delivery stops at staged for delivery', async () => {
    const { stub } = chain('picking_complete', { fulfillment: 'delivery' });
    const out = await svc(stub).prepareForHandover(ORDER);
    expect(out.status).toBe('staged_for_delivery');
    expect(out.ran.map((r) => `${r.step}:${r.outcome}`)).toEqual([
      'pick_slip:already',
      'pick:already',
      'packing_slips:done',
      'stage:done',
    ]);
  });

  it('skips what is done: at packing slips it only stages', async () => {
    const { stub } = chain('packing_slip_generated');
    const out = await svc(stub).prepareForHandover(ORDER);
    expect(out.ran.map((r) => `${r.step}:${r.outcome}`)).toEqual([
      'pick_slip:already',
      'pick:already',
      'packing_slips:already',
      'stage:done',
    ]);
    expect(stub.rpcCalls).toEqual([]);
  });

  it('stops at the first refusal: the return-first gate holds the pick slip, nothing after it runs', async () => {
    const { stub, state } = chain('approved', { refuse: { pick_slip: 'replacement_waiting_for_return' } });
    const out = await svc(stub).prepareForHandover(ORDER);
    expect(out.ran).toEqual([
      {
        step: 'pick_slip',
        outcome: 'refused',
        reason: 'replacement_waiting_for_return',
        message: 'Waiting for the returned item.',
      },
    ]);
    expect(state.status).toBe('approved');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a picking refusal keeps the pick slip done and stops before the packing slips', async () => {
    const { stub } = chain('pick_slip_generated', { refuse: { pick: 'insufficient_stock' } });
    const out = await svc(stub).prepareForHandover(ORDER);
    expect(out.ran.map((r) => `${r.step}:${r.outcome}`)).toEqual(['pick_slip:already', 'pick:refused']);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['complete_picking']);
  });

  it('a staff member claims an unclaimed order before picking; a claimed one is not claimed again', async () => {
    const staffPerms = new Set(['orders:approve', 'items:update', 'orders:request']);
    const unclaimed = chain('pick_slip_generated');
    await svc(unclaimed.stub, { role: 'staff', permissions: staffPerms }).prepareForHandover(ORDER);
    expect(unclaimed.stub.rpcCalls.map((c) => c.name).slice(0, 2)).toEqual(['claim_picking', 'complete_picking']);
    const claimed = chain('picking_in_progress', { picker: 'someone' });
    await svc(claimed.stub, { role: 'staff', permissions: staffPerms }).prepareForHandover(ORDER);
    expect(claimed.stub.rpcCalls.map((c) => c.name)[0]).toBe('complete_picking');
  });

  it('nothing to prepare for a handed-over or dead order', async () => {
    for (const status of ['completed', 'in_transit', 'cancelled', 'backordered']) {
      const { stub } = chain(status);
      const out = await svc(stub).prepareForHandover(ORDER);
      expect(out.ran).toEqual([]);
      expect(stub.rpcCalls).toEqual([]);
    }
  });
});

describe('the orders list Exchange chip (plan 3.6.9)', () => {
  const rows = [
    { id: 'o1', order_number: 1, status: 'approved', warehouse_id: 'wh-1', source: 'internal', replacement_for_return_id: RMA, lines: [] },
    { id: 'o2', order_number: 2, status: 'approved', warehouse_id: 'wh-1', source: 'internal', replacement_for_return_id: null, lines: [] },
    { id: 'o3', order_number: 3, status: 'cancelled', warehouse_id: 'wh-1', source: 'internal', replacement_for_return_id: RMA, lines: [] },
  ];

  it('one batched return_overview read for the page; the live replacement carries the gate words', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: rows, error: null },
      'return_overview.select': {
        data: [{ id: RMA, return_number: 'RMA-1', replacement_order_id: 'o1', exchange_status: 'waiting_for_return' }],
        error: null,
      },
    });
    const list = await svc(stub).list({ limit: 50 });
    expect(stub.fromCalls.filter((t) => t === 'return_overview')).toHaveLength(1);
    expect(list.map((r) => [r.id, r.replacementForReturnId, r.exchange?.state ?? null])).toEqual([
      ['o1', RMA, 'Waiting for return'],
      ['o2', null, null],
      ['o3', RMA, null],
    ]);
    expect(list[0]!.exchange?.returnNumber).toBe('RMA-1');
  });

  it('a page without a replacement reads no return_overview at all', async () => {
    const stub = makeSupabaseStub({ 'order_requests.select': { data: [rows[1]], error: null } });
    await svc(stub).list({ limit: 50 });
    expect(stub.fromCalls).not.toContain('return_overview');
  });
});
