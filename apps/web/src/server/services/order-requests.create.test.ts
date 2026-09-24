import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * create() writes the header and its lines through ONE call,
 * create_order_request (0365), instead of two inserts and a delete-based
 * "rollback". The old shape left a line-less order behind whenever the line
 * insert failed and the compensating delete failed too (or was refused by
 * RLS); the function is one transaction, so a failure leaves nothing.
 *
 * Pinned here: exactly one rpc call and no direct writes; duplicate items
 * collapse to one line (summed, first non-null note); the error classes map
 * to the right ServiceError codes; nothing is audited, emailed or dispatched
 * for an order that was not created; and a failed charter-pair read is an
 * internal error, not "that site is not serviced".
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
const { audit, dispatchEvent } = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  dispatchEvent: vi.fn(async () => {}),
}));
vi.mock('./audit', () => ({ audit }));
vi.mock('./integration-events', () => ({ dispatchEvent }));

import { OrderRequestsService } from './order-requests';

const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_A = 'bbbbbbbb-0000-4000-8000-00000000000a';
const ITEM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CHARTER = 'cccccccc-0000-4000-8000-000000000001';

function itemRow(id: string) {
  return {
    id,
    name: `Item ${id.slice(-1)}`,
    warehouse_id: WH,
    unit_cost: 4,
    awaiting_first_receipt: false,
    is_rental: false,
  };
}

const CREATED = {
  id: 'order-1',
  order_number: 42,
  organization_id: 'org-test',
  warehouse_id: WH,
  status: 'pending_approval',
  source: 'internal',
  requester_name: null,
};

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'staff',
      userId: 'requester-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

// The submitted-email tail (a private method, deferred past the response).
type WithNotify = { notifyEmail: (...args: unknown[]) => Promise<void> };
let notifyEmail: MockInstance<WithNotify['notifyEmail']>;
beforeEach(() => {
  vi.clearAllMocks();
  notifyEmail = vi
    .spyOn(OrderRequestsService.prototype as unknown as WithNotify, 'notifyEmail')
    .mockResolvedValue(undefined);
});

function rpcArgs(stub: ReturnType<typeof makeSupabaseStub>) {
  const call = stub.rpcCalls.find((c) => c.name === 'create_order_request');
  return call?.args as {
    p_header: Record<string, unknown>;
    p_lines: Array<{ item_id: string; quantity: number; notes: string | null }>;
  };
}

function expectNoDirectWrites(stub: ReturnType<typeof makeSupabaseStub>) {
  for (const key of [
    'order_requests.insert',
    'order_requests.delete',
    'order_request_lines.insert',
    'order_request_lines.delete',
  ]) {
    expect(stub.chainsAll.get(key), key).toBeUndefined();
  }
}

describe('OrderRequestsService.create — one transactional write', () => {
  it('calls create_order_request exactly once and never writes the tables directly', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A), itemRow(ITEM_B)], error: null },
      'rpc:create_order_request': { data: CREATED, error: null },
    });

    const row = await svc(stub).create({
      warehouseId: WH,
      fulfillmentType: 'pickup',
      notes: 'For room 12',
      neededBy: '2026-10-01T15:00:00.000Z',
      lines: [
        { itemId: ITEM_A, quantity: 2 },
        { itemId: ITEM_B, quantity: 1, notes: 'blue' },
      ],
    });

    expect(row.id).toBe('order-1');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['create_order_request']);
    expectNoDirectWrites(stub);

    const { p_header, p_lines } = rpcArgs(stub);
    expect(p_header).toEqual({
      organization_id: 'org-test',
      warehouse_id: WH,
      requester_user_id: 'requester-1',
      requester_name: null,
      requester_email: null,
      notes: 'For room 12',
      needed_by: '2026-10-01T15:00:00.000Z',
      fulfillment_type: 'pickup',
      requester_phone: null,
      delivery_charter_id: null,
      pickup_location_notes: null,
    });
    // source/status are fixed by the function; the cost snapshot is a trigger's.
    expect(p_header).not.toHaveProperty('source');
    expect(p_header).not.toHaveProperty('status');
    expect(p_lines).toEqual([
      { item_id: ITEM_A, quantity: 2, notes: null },
      { item_id: ITEM_B, quantity: 1, notes: 'blue' },
    ]);
  });

  it('records an on-behalf-of order with no requester_user_id and the external identity', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'rpc:create_order_request': { data: CREATED, error: null },
    });
    await svc(stub).create({
      warehouseId: WH,
      fulfillmentType: 'pickup',
      onBehalfOf: { name: 'Doua Vang', email: 'doua@example.org' },
      lines: [{ itemId: ITEM_A, quantity: 1 }],
    });
    const { p_header } = rpcArgs(stub);
    expect(p_header).toMatchObject({
      requester_user_id: null,
      requester_name: 'Doua Vang',
      requester_email: 'doua@example.org',
    });
  });

  it('merges duplicate items into one line: [{A,5},{A,5}] is one line of 10', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A), itemRow(ITEM_B)], error: null },
      'rpc:create_order_request': { data: CREATED, error: null },
    });
    await svc(stub).create({
      warehouseId: WH,
      fulfillmentType: 'pickup',
      lines: [
        { itemId: ITEM_A, quantity: 5 },
        { itemId: ITEM_B, quantity: 1 },
        { itemId: ITEM_A, quantity: 5, notes: 'first note' },
        { itemId: ITEM_A, quantity: 1, notes: 'later note' },
      ],
    });

    const { p_lines } = rpcArgs(stub);
    expect(p_lines).toEqual([
      // Summed; the first non-null note wins, a later one does not overwrite.
      { item_id: ITEM_A, quantity: 11, notes: 'first note' },
      { item_id: ITEM_B, quantity: 1, notes: null },
    ]);
    // The audit and the webhook count the lines that were written.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ after: { lineCount: 2, warehouseId: WH } }),
      expect.anything(),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      'org-test',
      'order.created',
      expect.objectContaining({ lineCount: 2 }),
    );
    expect(notifyEmail).toHaveBeenCalledTimes(1);
  });

  it('exactly [{A,5},{A,5}] becomes a single line of 10', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'rpc:create_order_request': { data: CREATED, error: null },
    });
    await svc(stub).create({
      warehouseId: WH,
      fulfillmentType: 'pickup',
      lines: [
        { itemId: ITEM_A, quantity: 5 },
        { itemId: ITEM_A, quantity: 5 },
      ],
    });
    expect(rpcArgs(stub).p_lines).toEqual([{ item_id: ITEM_A, quantity: 10, notes: null }]);
  });
});

describe('OrderRequestsService.create — failures create nothing and announce nothing', () => {
  function failingStub(error: { message: string; code?: string }) {
    return makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'rpc:create_order_request': { data: null, error },
    });
  }
  const input = {
    warehouseId: WH,
    fulfillmentType: 'pickup' as const,
    lines: [{ itemId: ITEM_A, quantity: 1 }],
  };

  it.each([
    [{ message: 'A request needs at least one line', code: '22023' }, 'validation_error'],
    [{ message: 'new row violates row-level security policy', code: '42501' }, 'forbidden'],
    [{ message: 'deadlock detected', code: '40P01' }, 'internal_error'],
    [{ message: 'fetch failed' }, 'internal_error'],
  ])('maps %o to %s, with no audit, email or webhook', async (error, code) => {
    const stub = failingStub(error);
    const err = await svc(stub)
      .create(input)
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe(code);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['create_order_request']);
    expectNoDirectWrites(stub);
    expect(audit).not.toHaveBeenCalled();
    expect(notifyEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  // The 0365 guards raise whole sentences for the requester (42501 / 23514).
  // Mapped by code alone they read "You are not allowed to create this
  // request." and "An internal error occurred."
  it.each([
    ['That item cannot be ordered: it is deleted, a rental item, or not received yet.', '42501'],
    ['A line needs a real quantity.', '23514'],
    ['A new order request starts pending approval.', '42501'],
    [
      'A new order request cannot carry approval, picking, delivery or signature details.',
      '42501',
    ],
  ])('passes the guard sentence "%s" (%s) through as a validation_error', async (message, code) => {
    const err = await svc(failingStub({ message, code }))
      .create(input)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'validation_error', message });
    expect(audit).not.toHaveBeenCalled();
    expect(notifyEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps a 42501 that is not a guard sentence as forbidden', async () => {
    const err = await svc(
      failingStub({
        message:
          'A new order line starts unfulfilled; picking, packing, fulfilment and pricing are recorded by the order workflow.',
        code: '42501',
      }),
    )
      .create(input)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'forbidden',
      message: 'You are not allowed to create this request.',
    });
  });

  it('passes the 22023 message through as the validation message', async () => {
    const err = await svc(
      failingStub({ message: 'A request needs at least one line', code: '22023' }),
    )
      .create(input)
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe('A request needs at least one line');
  });

  it.each([
    ['null', null],
    ['an array', [CREATED]],
    ['a row with no id', { order_number: 1 }],
  ])('treats %s from the function as internal_error, announcing nothing', async (_label, data) => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'rpc:create_order_request': { data, error: null },
    });
    await expect(svc(stub).create(input)).rejects.toMatchObject({ code: 'internal_error' });
    expect(audit).not.toHaveBeenCalled();
    expect(notifyEmail).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('OrderRequestsService.create — delivery site check', () => {
  const deliveryInput = {
    warehouseId: WH,
    fulfillmentType: 'delivery' as const,
    deliveryCharterId: CHARTER,
    lines: [{ itemId: ITEM_A, quantity: 1 }],
  };

  it('a failed warehouse_charters read is internal_error, not "not serviced", and writes nothing', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'warehouse_charters.select.maybeSingle': {
        data: null,
        error: { message: 'connection reset' },
      },
      'rpc:create_order_request': { data: CREATED, error: null },
    });
    const err = await svc(stub)
      .create(deliveryInput)
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('internal_error');
    expect((err as Error).message).not.toContain('not serviced');
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a pair that genuinely does not exist is still the validation message', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'warehouse_charters.select.maybeSingle': { data: null, error: null },
    });
    await expect(svc(stub).create(deliveryInput)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'That site is not serviced by the chosen warehouse.',
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a serviced pair reaches the write with the charter on the header', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [itemRow(ITEM_A)], error: null },
      'warehouse_charters.select.maybeSingle': { data: { charter_id: CHARTER }, error: null },
      'rpc:create_order_request': { data: CREATED, error: null },
    });
    await svc(stub).create(deliveryInput);
    expect(rpcArgs(stub).p_header).toMatchObject({
      fulfillment_type: 'delivery',
      delivery_charter_id: CHARTER,
    });
  });
});
