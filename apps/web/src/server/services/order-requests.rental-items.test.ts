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
// order without the requester seeing it. The server now refuses it by name.

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
  it('reads is_rental with the other line checks', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [RENTAL], error: null },
    });
    await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: RENTAL.id, quantity: 1 }] } as never)
      .catch(() => undefined);
    // First inventory_items query, first method (`select`), its column list.
    const columns = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0];
    expect(String(columns).split(',').map((c) => c.trim())).toContain('is_rental');
  });

  it('create REFUSES a rental line, naming the item, before any write', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [RENTAL], error: null },
    });
    const err = await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: RENTAL.id, quantity: 1 }] } as never)
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toBe(
      'MacBook Pro 14" is a rental item. Check it out from Rentals instead of ordering it.',
    );
    expect(stub.chainsAll.get('order_requests.insert')).toBeUndefined();
  });

  it('create lets a non-rental line through to the header insert', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ ...RENTAL, name: 'Widget', is_rental: false }], error: null },
      // Sentinel: reaching the header insert proves the line checks passed.
      'order_requests.insert': { data: null, error: { message: 'sentinel-header-insert' } },
    });
    const err = await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: RENTAL.id, quantity: 1 }] } as never)
      .catch((e: unknown) => e);

    expect((err as { code: string }).code).toBe('internal_error');
    expect(stub.chainsAll.get('order_requests.insert')).toBeDefined();
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
