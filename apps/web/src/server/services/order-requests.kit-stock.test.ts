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
// kits on the New order page; production had no such item). The server now
// refuses it by name. The database line guard is the next migration's job.

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
  it('reads is_bundle with the other line checks', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [KIT_STOCK], error: null },
    });
    await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: KIT_STOCK.id, quantity: 1 }] } as never)
      .catch(() => undefined);
    const columns = stub.chainArgsAll.get('inventory_items.select')?.[0]?.[0]?.[0];
    expect(String(columns).split(',').map((c) => c.trim())).toContain('is_bundle');
  });

  it('create REFUSES a kit-stock line, naming it, before any write', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [KIT_STOCK], error: null },
    });
    const err = await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: KIT_STOCK.id, quantity: 1 }] } as never)
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('validation_error');
    expect((err as Error).message).toBe(REFUSAL);
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('create_order_request');
  });

  it('create lets an ordinary item through to the write', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ ...KIT_STOCK, name: 'Backpack', is_bundle: false }], error: null },
      'rpc:create_order_request': { data: null, error: { message: 'sentinel-create' } },
    });
    const err = await svc(stub)
      .create({ warehouseId: WH, fulfillmentType: 'pickup', lines: [{ itemId: KIT_STOCK.id, quantity: 1 }] } as never)
      .catch((e: unknown) => e);
    expect((err as { internalDetail?: string }).internalDetail).toBe('sentinel-create');
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
