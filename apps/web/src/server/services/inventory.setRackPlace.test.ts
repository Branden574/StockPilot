import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Bulk "Set rack" must not only write the rack LABEL — it must PLACE each
// selected item's staging/unplaced stock onto that rack (transfer_stock),
// so stock actually moves out of staging in one action.
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, writableIds: [], readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

describe('bulkUpdate set_rack — places stock, not just a label', () => {
  it('transfers each item\'s staging holding onto the named rack', async () => {
    const stub = makeSupabaseStub({
      // allowedIds load AND the placement\'s items load both hit this:
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      // the label RPC returns the updated row count:
      'rpc:inventory_set_rack': { data: 1, error: null },
      // the item\'s not-yet-placed (staging) holding:
      'item_stock_levels.select': {
        data: [{ item_id: 'item-1', location_id: 'stg-1', quantity: 8 }],
        error: null,
      },
      // an existing rack named "1-A" in wh-1 (so no create needed):
      'locations.select': { data: { id: 'rack-1' }, error: null },
      // the placement transfer:
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const res = await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: '1', rackRow: 'A' },
    });

    expect(res.ok).toBe(1);
    // The LABEL was still written.
    expect(stub.rpcCalls.some((c) => c.name === 'inventory_set_rack')).toBe(true);
    // AND the staging stock was PLACED onto the rack (the actual fix).
    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-1',
      p_from_location_id: 'stg-1',
      p_to_location_id: 'rack-1',
      p_quantity: 8,
    });
  });

  it('clearing the rack (null) writes the label but moves no stock', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1', warehouse_id: 'wh-1' }], error: null },
      'rpc:inventory_set_rack': { data: 1, error: null },
      'item_stock_levels.select': {
        data: [{ item_id: 'item-1', location_id: 'stg-1', quantity: 8 }],
        error: null,
      },
      'rpc:transfer_stock': { data: null, error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkUpdate({
      ids: ['item-1'],
      op: { kind: 'set_rack', rackNumber: null, rackRow: null },
    });

    expect(stub.rpcCalls.some((c) => c.name === 'transfer_stock')).toBe(false);
  });
});
