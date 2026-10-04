import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

// Warehouse access is enforced elsewhere (lib/auth/warehouse) — stub it so the
// service method runs; audit is a fire-and-forget side effect.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Expected-items visibility (mig 0277): pickers and catalogs exclude items
// awaiting their first receipt, but a crafted payload can still name any item
// id. addLines() refuses a flagged line by name and lets an unflagged
// zero-stock line through (established out-of-stock items are orderable as
// backorders). Since phone ordering PO-2, create() leaves the check to
// place_order_request (order_items_orderable 'awaiting_first_receipt', 0391;
// pgTAP R10 and R12) and passes the recorded refusal on as final.

const WH_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ITEM_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, { role: 'admin' }),
  );
}

const OPEN_ORDER = {
  'order_requests.select': {
    data: {
      id: 'order-1',
      status: 'approved',
      warehouse_id: WH_ID,
      requester_user_id: 'requester-1',
      pick_slip_generated_at: null,
      order_number: 12,
    },
    error: null,
  },
  'order_request_lines.select': { data: [], error: null },
};

describe('expected-items guard (mig 0277)', () => {
  it('addLines REJECTS a line whose item is awaiting its first receipt, naming the item', async () => {
    const stub = makeSupabaseStub({
      ...OPEN_ORDER,
      'inventory_items.select': {
        data: [
          {
            id: ITEM_ID,
            name: 'PD 8/7 Lanyard',
            warehouse_id: WH_ID,
            unit_cost: 3,
            awaiting_first_receipt: true,
          },
        ],
        error: null,
      },
    });

    const err = await svc(stub)
      .addLines('order-1', [{ itemId: ITEM_ID, quantity: 2 }])
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toContain("This item hasn't been received yet");
    expect((err as Error).message).toContain('PD 8/7 Lanyard');
    expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
  });

  it('addLines does NOT trip on an established zero-stock item (the guard is flag-driven, not quantity-driven)', async () => {
    const stub = makeSupabaseStub({
      ...OPEN_ORDER,
      'inventory_items.select': {
        data: [
          {
            id: ITEM_ID,
            name: 'Dell XPS',
            warehouse_id: WH_ID,
            unit_cost: 900,
            awaiting_first_receipt: false,
          },
        ],
        error: null,
      },
    });

    const err = await svc(stub)
      .addLines('order-1', [{ itemId: ITEM_ID, quantity: 2 }])
      .catch((e: unknown) => e);

    expect(String((err as Error | undefined)?.message ?? '')).not.toContain("hasn't been received yet");
    // The read of the order's existing lines comes after the item checks:
    // reaching it proves the guard let the unflagged line through.
    expect(stub.chainsAll.get('order_request_lines.select')).toBeDefined();
  });

  it('create leaves it to the database and passes the recorded refusal on as final', async () => {
    const stub = makeSupabaseStub({
      'rpc:place_order_request': {
        data: {
          outcome: 'refused',
          replay: false,
          refusal: { reason: 'item_not_orderable', detail: { [ITEM_ID]: 'awaiting_first_receipt' } },
        },
        error: null,
      },
    });
    const err = await svc(stub)
      .create({
        body: {
          idempotencyKey: 'eeeeeeee-0000-4000-8000-000000000001',
          placerUserId: 'dddddddd-0000-4000-8000-000000000001',
          warehouseId: WH_ID,
          fulfillmentType: 'pickup',
          deliveryCharterId: null,
          onBehalfOf: null,
          notes: null,
          neededByLocal: null,
          lines: [{ itemId: ITEM_ID, quantity: 2 }],
        },
        surface: 'web',
      })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as { details: { items: unknown } }).details.items).toEqual({ [ITEM_ID]: 'awaiting_first_receipt' });
    expect(stub.fromCalls).not.toContain('inventory_items');
  });
});
