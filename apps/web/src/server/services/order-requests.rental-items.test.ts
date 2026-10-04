import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHandle.client,
}));
const adminHandle: { client: unknown } = { client: null };

// Rental items go out through Rentals (a hold, returned later), never on an
// order. Every order picker leaves them out, but create() and addLines()
// accepted any item id a client sent. The New rental page shared its saved
// cart with the Orders page (2026-09-24), so a rental line could reach an
// order without the requester seeing it. addLines refuses it by name; since
// phone ordering PO-2 create() leaves it to place_order_request (0391).

const WH = 'aaaaaaaa-0000-0000-0000-000000000001';
const RENTAL = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  name: 'MacBook Pro 14"',
  warehouse_id: WH,
  unit_cost: 1999,
  awaiting_first_receipt: false,
  is_rental: true,
};

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      userId: 'approver-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

describe('OrderRequestsService — rental items are never ordered', () => {
  it('reads is_rental with the other line checks (addLines)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: {
          id: 'order-1',
          status: 'approved',
          warehouse_id: WH,
          requester_user_id: 'requester-1',
          pick_slip_generated_at: null,
          order_number: 12,
        },
        error: null,
      },
      'inventory_items.select': { data: [RENTAL], error: null },
      'order_request_lines.select': { data: [], error: null },
    });
    await svc(stub)
      .addLines('order-1', [{ itemId: RENTAL.id, quantity: 1 }])
      .catch(() => undefined);
    // First inventory_items query, first method (`select`), its column list.
    const columns = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0];
    expect(String(columns).split(',').map((c) => c.trim())).toContain('is_rental');
  });

  // create(): the rental check is place_order_request's (order_items_orderable,
  // 0391; pgTAP R10). The service reads no item and passes the recorded
  // refusal on as final, naming the item by id; the screens name it from the
  // person's own cart (core orderItemRefusalCopy: "... is a rental item").
  it('create leaves the rental check to the database and passes its recorded refusal on', async () => {
    const stub = makeSupabaseStub({
      'rpc:place_order_request': {
        data: { outcome: 'refused', replay: false, refusal: { reason: 'item_not_orderable', detail: { [RENTAL.id]: 'rental' } } },
        error: null,
      },
    });
    const err = await svc(stub)
      .create({
        body: {
          idempotencyKey: 'eeeeeeee-0000-4000-8000-000000000001',
          placerUserId: 'dddddddd-0000-4000-8000-000000000001',
          warehouseId: WH,
          fulfillmentType: 'pickup',
          deliveryCharterId: null,
          onBehalfOf: null,
          notes: null,
          neededByLocal: null,
          lines: [{ itemId: RENTAL.id, quantity: 1 }],
        },
        surface: 'web',
      })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as { details: unknown }).details).toEqual({
      reason: 'item_not_orderable',
      settled: true,
      replay: false,
      items: { [RENTAL.id]: 'rental' },
    });
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['place_order_request']);
  });

  it('addLines REFUSES a rental item on an open order, before any write', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: {
          id: 'order-1',
          status: 'approved',
          warehouse_id: WH,
          requester_user_id: 'requester-1',
          pick_slip_generated_at: null,
          order_number: 12,
        },
        error: null,
      },
      'inventory_items.select': { data: [RENTAL], error: null },
      'order_request_lines.select': { data: [], error: null },
    });
    const err = await svc(stub)
      .addLines('order-1', [{ itemId: RENTAL.id, quantity: 1 }])
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toContain('is a rental item');
    expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
    expect(stub.chainsAll.get('order_request_lines.update')).toBeUndefined();
  });
});
