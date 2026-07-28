import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

/**
 * The SIZED fan-out's sports parity (Task 11 review finding 1).
 *
 * `bulkCreateSizedVariants` is the path a SIZED sports category takes — shoes,
 * the canonical case — so everything `create()` does for a sports item has to
 * happen here too, or the Add Item preview promises a product group that never
 * gets saved. The invariants these tests pin:
 *
 *   - `productGroup` find-or-creates and stamps `group_id` on EVERY row;
 *   - `group_key` and `variant_key` are computed SERVER-side, never accepted;
 *   - `trackingModeOverride` goes through the same `resolveModeOverride` gate
 *     (`sports:manage` + the subcategory's allowedModes) as `create()`;
 *   - the shared variant attributes (number/width/fit/colour) are persisted and
 *     participate in the variant key;
 *   - none of it fires for a non-sports category.
 */

const BASE = {
  baseName: 'Nike Pegasus 41',
  baseSku: 'SP-TEST',
  baseBarcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  variants: [
    { size: '9', quantity: 1 },
    { size: '10', quantity: 2 },
  ],
};

function categoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    parent_id: null,
    tracking_mode: null,
    size_scale_id: null,
    default_unit_of_measure: null,
    sports_subcategory_key: null,
    tracking_profile: null,
    deleted_at: null,
    ...over,
  };
}

/** Shoes REQUIRE size + size_system, so the category always carries a scale. */
function shoesCategory(over: Record<string, unknown> = {}) {
  return categoryRow({ sports_subcategory_key: 'shoes', size_scale_id: 'scale-1', ...over });
}

function jerseysCategory(over: Record<string, unknown> = {}) {
  return categoryRow({ sports_subcategory_key: 'jerseys', size_scale_id: 'scale-1', ...over });
}

function buildStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'size_scales.select': { data: { id: 'scale-1', size_system: 'US_MENS' }, error: null },
    // A scale with no values yet: the system is known, every size is allowed.
    'size_scale_values.select': { data: [], error: null },
    'inventory_items.insert': {
      data: [
        { id: 'i-0', name: 'Nike Pegasus 41 - 9', sku: 'SP-TEST-9', quantity_on_hand: 1, primary_location_id: null },
        { id: 'i-1', name: 'Nike Pegasus 41 - 10', sku: 'SP-TEST-10', quantity_on_hand: 2, primary_location_id: null },
      ],
      error: null,
    },
    'stock_movements.insert': { data: null, error: null },
    ...over,
  });
}

function insertedRows(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] as Array<
    Record<string, unknown>
  >;
}

const SPORTS_ON = new Set<ModuleId>(['inventory', 'sports']);

describe('InventoryService.bulkCreateSizedVariants — sports parity with create()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('find-or-creates the product group and stamps its id on every variant row', async () => {
    const stub = buildStub({
      'categories.select': { data: shoesCategory(), error: null },
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: { id: 'grp-new' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await new InventoryService(ctx).bulkCreateSizedVariants({
      ...BASE,
      productGroup: {
        name: 'Nike Pegasus 41',
        brand: 'Nike',
        model: 'Pegasus 41',
        defaultCountingUnit: 'pair',
      },
    });

    const rows = insertedRows(stub);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.group_id).toBe('grp-new');

    // group_key is DERIVED from the attributes, never supplied by the caller.
    const groupInsert = stub.chainArgs.get('product_groups.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(groupInsert.group_key).toBe('shoes|nike|pegasus 41||');
    expect(groupInsert.subcategory_key).toBe('shoes');
  });

  it('ignores productGroup entirely for a non-sports category (nothing is grouped by accident)', async () => {
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await new InventoryService(ctx).bulkCreateSizedVariants({
      ...BASE,
      productGroup: { name: 'Nike Pegasus 41', brand: 'Nike', defaultCountingUnit: 'each' },
    });

    expect(stub.fromCalls).not.toContain('product_groups');
    for (const r of insertedRows(stub)) expect(r.group_id).toBeNull();
  });

  it('persists the shared variant attributes and folds them into the SERVER-computed variant key', async () => {
    const stub = buildStub({
      'categories.select': { data: jerseysCategory(), error: null },
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: { id: 'grp-j' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await new InventoryService(ctx).bulkCreateSizedVariants({
      ...BASE,
      variants: [
        { size: 'M', quantity: 3 },
        { size: 'XL', quantity: 2 },
      ],
      jerseyNumber: '07',
      playerName: 'Vega',
      variantColor: 'Navy',
      variantFit: 'Regular',
      productGroup: { name: 'Wildcats home', team: 'Wildcats', defaultCountingUnit: 'each' },
    });

    const rows = insertedRows(stub);
    // R3: two variants sharing ONE jersey number, per-size quantities retained.
    expect(rows.map((r) => r.jersey_number)).toEqual(['07', '07']);
    expect(rows.map((r) => r.quantity_on_hand)).toEqual([3, 2]);
    expect(rows.map((r) => r.player_name)).toEqual(['Vega', 'Vega']);
    expect(rows[0]?.variant_color).toBe('Navy');
    expect(rows[0]?.variant_fit).toBe('Regular');
    // The key carries the number/fit/colour AND the per-row size, and omits
    // player exactly as create() does — the two paths must agree byte-for-byte
    // or the same physical jersey lands as two variants.
    expect(rows[0]?.variant_key).toBe('number=07|size=m|system=us_mens|fit=regular|color=navy');
    expect(rows[1]?.variant_key).toBe('number=07|size=xl|system=us_mens|fit=regular|color=navy');
  });

  it('honours an authorized trackingModeOverride and stamps the mapped tracking_type', async () => {
    const stub = buildStub({
      'categories.select': { data: shoesCategory(), error: null },
    });
    // admin holds sports:manage.
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await new InventoryService(ctx).bulkCreateSizedVariants({
      ...BASE,
      trackingModeOverride: 'OPTIONAL_SERIALIZED',
    });

    for (const r of insertedRows(stub)) expect(r.tracking_type).toBe('serial_optional');
  });

  it('refuses a trackingModeOverride from a caller without sports:manage', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    // staff can create items but never re-decides how a product is tracked.
    const ctx = makeServiceContext(stub.client, {
      role: 'staff',
      enabledModules: SPORTS_ON,
    });

    await expect(
      new InventoryService(ctx).bulkCreateSizedVariants({
        ...BASE,
        trackingModeOverride: 'OPTIONAL_SERIALIZED',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });

  it('refuses a trackingModeOverride the subcategory does not allow', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await expect(
      new InventoryService(ctx).bulkCreateSizedVariants({
        ...BASE,
        // Shoes allow QUANTITY_BY_VARIANT / QUANTITY / OPTIONAL_SERIALIZED only.
        trackingModeOverride: 'SERIALIZED',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });

  it('enforces the subcategory attribute rules — a jersey number on shoes is refused', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });

    await expect(
      new InventoryService(ctx).bulkCreateSizedVariants({ ...BASE, jerseyNumber: '07' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });
});
