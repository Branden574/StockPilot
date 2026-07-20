import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

// Warehouse access is enforced elsewhere (lib/auth/warehouse) — stub it so the
// service method runs; audit is a fire-and-forget side effect.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Expected-items visibility (mig 0277): OrderRequestsService.create() is the
// authoritative server-side gate — pickers and catalogs already exclude items
// awaiting their first receipt, but a crafted payload can still POST any item
// id. A flagged line must be rejected with a clear message; an unflagged
// zero-stock line must pass the guard (established out-of-stock items are
// orderable as backorders today).

const WH_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ITEM_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, { role: 'admin' }),
  );
}

function createInput() {
  return {
    warehouseId: WH_ID,
    fulfillmentType: 'pickup' as const,
    lines: [{ itemId: ITEM_ID, quantity: 2 }],
  };
}

describe('OrderRequestsService.create — expected-items guard (mig 0277)', () => {
  it('REJECTS a line whose item is awaiting its first receipt, naming the item', async () => {
    const stub = makeSupabaseStub({
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
      .create(createInput() as never)
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toContain("This item hasn't been received yet");
    expect((err as Error).message).toContain('PD 8/7 Lanyard');
    // Fails BEFORE any write: no order_requests header may exist.
    expect(stub.chainsAll.get('order_requests.insert')).toBeUndefined();
  });

  it('does NOT trip on an established zero-stock item (unflagged) — the guard is flag-driven, not quantity-driven', async () => {
    const stub = makeSupabaseStub({
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
      // Sentinel failure on the header insert: reaching it proves the
      // expected-items guard passed the unflagged line through.
      'order_requests.insert': { data: null, error: { message: 'sentinel-header-insert' } },
    });

    const err = await svc(stub)
      .create(createInput() as never)
      .catch((e: unknown) => e);

    // NOT the expected-items validation error — the flow ran past the
    // guard and died on the sentinel header insert instead.
    expect((err as { code: string }).code).toBe('internal_error');
    expect((err as Error).message).not.toContain("hasn't been received yet");
    expect(stub.chainsAll.get('order_requests.insert')).toBeDefined();
  });
});
