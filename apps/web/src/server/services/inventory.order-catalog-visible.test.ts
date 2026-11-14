import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

/**
 * Ordering visibility on the create path (0413, design 2.3). A new record
 * takes the database default (shown in Orders): create() sends no
 * order_catalog_visible unless a server-only caller passes
 * opts.orderCatalogVisible = false (a restore point or a PO-import charter
 * sibling copying a hidden source). The public input cannot carry it.
 */

const BASE = {
  name: 'Test item',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  // `unitOfMeasure` is deliberately ABSENT: it is optional in createItemSchema
  // now, and omitting it is the only way a caller says "take the category
  // default". Tests that care pass one explicitly.
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
};

function buildStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    // Plan-limit head count.
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'item-new' }, error: null },
    'stock_movements.insert': { data: null, error: null },
    ...over,
  });
}

function insertedRow(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] as Record<string, unknown>;
}

describe('InventoryService.create and ordering visibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a new record sends no visibility: the database default (shown) applies', async () => {
    const stub = buildStub();
    await new InventoryService(makeServiceContext(stub.client)).create({ ...BASE });
    expect(insertedRow(stub)).not.toHaveProperty('order_catalog_visible');
  });

  it('the server-only option creates it hidden', async () => {
    const stub = buildStub();
    await new InventoryService(makeServiceContext(stub.client)).create({ ...BASE }, { orderCatalogVisible: false });
    expect(insertedRow(stub).order_catalog_visible).toBe(false);
  });

  it('the option set to true sends nothing (shown is the default)', async () => {
    const stub = buildStub();
    await new InventoryService(makeServiceContext(stub.client)).create({ ...BASE }, { orderCatalogVisible: true });
    expect(insertedRow(stub)).not.toHaveProperty('order_catalog_visible');
  });

  it('the public input cannot carry it: a field in the input is ignored', async () => {
    const stub = buildStub();
    await new InventoryService(makeServiceContext(stub.client)).create({
      ...BASE,
      orderCatalogVisible: false,
      order_catalog_visible: false,
    } as never);
    expect(insertedRow(stub)).not.toHaveProperty('order_catalog_visible');
  });
});
