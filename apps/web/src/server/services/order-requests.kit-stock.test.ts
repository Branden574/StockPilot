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

// A kit's pre-assembled stock (inventory_items.is_bundle) is built and handed
// out through Bundles; it sits in Staging, and picking draws placed stock only,
// so an order line on it could never be picked. Every order picker leaves it
// out, but create() and addLines() never read the flag: a crafted payload or an
// old saved cart could put one on an order (found 2026-09-27 while designing
// kits on the New order page; production had no such item). addLines refuses
// it by name; since phone ordering PO-2 create() leaves it to
// place_order_request (order_items_orderable, 0391).

const WH = 'aaaaaaaa-0000-0000-0000-000000000001';
const KIT_STOCK = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  name: 'New Hire Bundle (kit)',
  warehouse_id: WH,
  unit_cost: 0,
  awaiting_first_receipt: false,
  is_rental: false,
  is_bundle: true,
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

const REFUSAL =
  "New Hire Bundle (kit) is a pre-assembled kit and can't be put on an order. Order the kit's items instead.";

describe('OrderRequestsService: a kit pre-assembled stock is never ordered', () => {
  it('reads is_bundle with the other line checks (addLines)', async () => {
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
      'inventory_items.select': { data: [KIT_STOCK], error: null },
      'order_request_lines.select': { data: [], error: null },
    });
    await svc(stub)
      .addLines('order-1', [{ itemId: KIT_STOCK.id, quantity: 1 }])
      .catch(() => undefined);
    const columns = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0];
    expect(String(columns).split(',').map((c) => c.trim())).toContain('is_bundle');
  });

  // create(): kit stock is place_order_request's check (order_items_orderable
  // 'kit_stock', 0391; pgTAP R10), recorded and passed on as final.
  it('create leaves the kit-stock check to the database and passes its recorded refusal on', async () => {
    const stub = makeSupabaseStub({
      'rpc:place_order_request': {
        data: { outcome: 'refused', replay: true, refusal: { reason: 'item_not_orderable', detail: { [KIT_STOCK.id]: 'kit_stock' } } },
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
          lines: [{ itemId: KIT_STOCK.id, quantity: 1 }],
        },
        surface: 'app',
      })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as { details: unknown }).details).toEqual({
      reason: 'item_not_orderable',
      settled: true,
      replay: true,
      items: { [KIT_STOCK.id]: 'kit_stock' },
    });
    expect(stub.fromCalls).not.toContain('inventory_items');
  });

  it('addLines REFUSES kit stock on an open order, before any write', async () => {
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
      'inventory_items.select': { data: [KIT_STOCK], error: null },
      'order_request_lines.select': { data: [], error: null },
    });
    const err = await svc(stub)
      .addLines('order-1', [{ itemId: KIT_STOCK.id, quantity: 1 }])
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toBe(REFUSAL);
    expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
    expect(stub.chainsAll.get('order_request_lines.update')).toBeUndefined();
  });
});
