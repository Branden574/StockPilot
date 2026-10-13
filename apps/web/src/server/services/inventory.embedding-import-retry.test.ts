import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The background embedding loop imports lib/ai/embeddings lazily, once, and
 * every later loop reuses that import. If the import fails (a module that does
 * not load), the failure must be forgotten: otherwise every later create,
 * edit, size run and duplicate in that instance would skip its embedding until
 * the instance restarts. Its own file because the import's state lives for the
 * whole module, and the first import here is made to fail.
 */

const h = vi.hoisted(() => ({
  factoryCalls: 0,
  kept: [] as Promise<unknown>[],
  embedded: [] as string[],
}));

vi.mock('@/lib/ai/embeddings', () => {
  h.factoryCalls += 1;
  if (h.factoryCalls === 1) throw new Error('the embeddings module failed to load');
  return {
    embedInventoryItem: vi.fn(async (id: string) => {
      h.embedded.push(id);
    }),
  };
});
vi.mock('./lib/defer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/defer')>()),
  keepAlive: vi.fn((work: Promise<unknown>) => {
    h.kept.push(work);
  }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [], writableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));

import { InventoryService } from './inventory';

const CREATE = {
  name: 'Chromebook',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
};

function service(newId: string) {
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: newId, quantity_on_hand: 0 }, error: null },
    'item_stock_levels.select': { data: [], error: null },
  });
  return new InventoryService(makeServiceContext(stub.client));
}

describe('a failed import of the embeddings module is not kept', () => {
  it('the next item after a failed import is embedded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await service('itm-first').create({ ...CREATE });
    await expect(h.kept[0]).resolves.toBeUndefined();
    // vitest wraps a mock factory's error; the cause is the one thrown.
    expect(warn).toHaveBeenCalledWith(
      '[embeddings] background embed failed:',
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'the embeddings module failed to load' }),
      }),
    );
    expect(h.embedded).toEqual([]);

    await service('itm-second').create({ ...CREATE });
    await h.kept[1];
    expect(h.factoryCalls).toBe(2);
    expect(h.embedded).toEqual(['itm-second']);
  });
});
