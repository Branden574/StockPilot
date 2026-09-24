import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// 2026-09-24 (owner DC4 report, on the Duplicate button). duplicate_inventory_item
// copies the original's primary location (a SITE such as "DC4") and the seed
// trigger puts the copy's stock AT that site. The dialog requires a rack, so the
// copy's stock must end on that rack, through the same placement helper a
// manual create uses.

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

function buildStub() {
  return makeSupabaseStub({
    'inventory_items.select': { data: { sku: 'SP-POLO', warehouse_id: 'wh-1' }, error: null },
    'rpc:duplicate_inventory_item': { data: 'dup-1', error: null },
    'locations.select': { data: [{ id: 'rack-31c', name: '31-C' }], error: null },
    'item_stock_levels.select': {
      data: [{ item_id: 'dup-1', location_id: 'site-dc4', quantity: 4 }],
      error: null,
    },
    'rpc:transfer_stock': { data: null, error: null },
  });
}

const BASE = {
  originalId: '00000000-0000-0000-0000-000000000001',
  itemType: 'product' as const,
  rackNumber: '31',
  rackRow: 'C',
  quantity: 4,
};

describe('InventoryService.duplicateItem puts the copy on the dialog rack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves the stock the trigger seeded at the SITE onto the typed rack', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.duplicateItem(BASE as never)).resolves.toBe('dup-1');

    const transfer = stub.rpcCalls.find((c) => c.name === 'transfer_stock');
    expect(transfer?.args).toMatchObject({
      p_item_id: 'dup-1',
      p_from_location_id: 'site-dc4',
      p_to_location_id: 'rack-31c',
      p_quantity: 4,
    });
  });

  it('a book copy keeps its crate-aware path (no rack auto-place here)', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.duplicateItem({ ...BASE, itemType: 'book', crateColor: 'blue', crateNumber: '1' } as never);
    expect(stub.rpcCalls.find((c) => c.name === 'transfer_stock')).toBeUndefined();
  });

  it('a copy with no stock moves nothing', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.duplicateItem({ ...BASE, quantity: 0 } as never);
    expect(stub.rpcCalls.find((c) => c.name === 'transfer_stock')).toBeUndefined();
  });
});
