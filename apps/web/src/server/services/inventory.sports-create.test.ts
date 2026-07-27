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
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

/**
 * `create()` is the most shared write path in the app, so the assertions that
 * matter most here are the ones proving the sports block is INERT for every
 * caller that existed before it: no category, a book, an explicitly serialized
 * item, an org with the sports module off.
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

const SPORTS_ON = new Set<ModuleId>(['inventory', 'sports']);
const LOT_SERIAL_ON = new Set<ModuleId>(['inventory', 'lot_serial']);

describe('InventoryService.create — non-sports regression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes group_id = null and variant_key = null for a plain item with no category', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE });

    const row = insertedRow(stub);
    expect(row.group_id).toBeNull();
    expect(row.variant_key).toBeNull();
    expect(row.variant_size).toBeNull();
    expect(row.jersey_number).toBeNull();
    expect(row.tracking_type).toBe('none');
    expect(row.unit_of_measure).toBe('unit');
    // No category means no category read at all.
    expect(stub.fromCalls).not.toContain('categories');
  });

  it('leaves a book untouched', async () => {
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE, itemType: 'book', categoryId: 'cat-1', name: 'Some book' });

    const row = insertedRow(stub);
    expect(row.item_type).toBe('book');
    expect(row.group_id).toBeNull();
    expect(row.variant_key).toBeNull();
    expect(row.tracking_type).toBe('none');
  });

  it('leaves a rental asset untouched', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE, itemType: 'asset', isRental: true });

    const row = insertedRow(stub);
    expect(row.is_rental).toBe(true);
    expect(row.group_id).toBeNull();
    expect(row.variant_key).toBeNull();
  });

  it('still honours an explicit trackingType when the category declares no policy', async () => {
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { enabledModules: LOT_SERIAL_ON }),
    );
    await svc.create({ ...BASE, categoryId: 'cat-1', trackingType: 'serial' });

    expect(insertedRow(stub).tracking_type).toBe('serial');
  });

  it('keeps the lot_serial gate exactly as it was for a directly-requested serial type', async () => {
    for (const trackingType of ['lot', 'serial', 'serial_optional'] as const) {
      const stub = buildStub();
      const ctx = makeServiceContext(stub.client, {
        enabledModules: new Set<ModuleId>(['inventory']),
      });
      await expect(
        new InventoryService(ctx).create({ ...BASE, trackingType }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
    }
  });
});

describe('InventoryService.create — category-driven tracking_type (R1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps serial for a SERIALIZED category even when the form says none', async () => {
    const stub = buildStub({
      'categories.select': { data: categoryRow({ tracking_mode: 'SERIALIZED' }), error: null },
    });
    const svc = new InventoryService(
      makeServiceContext(stub.client, { enabledModules: LOT_SERIAL_ON }),
    );
    await svc.create({ ...BASE, categoryId: 'cat-1', trackingType: 'none' });

    // R1: the category is the authority, so a receipt against this item still
    // hits post_receipt_v2's serials_required branch.
    expect(insertedRow(stub).tracking_type).toBe('serial');
  });

  it('still requires lot_serial when a NON-sports category stamps a serial type', async () => {
    const stub = buildStub({
      'categories.select': { data: categoryRow({ tracking_mode: 'SERIALIZED' }), error: null },
    });
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    await expect(
      new InventoryService(ctx).create({ ...BASE, categoryId: 'cat-1' }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('InventoryService.create — sports categories', () => {
  beforeEach(() => vi.clearAllMocks());

  const shoesCategory = () =>
    categoryRow({ sports_subcategory_key: 'shoes', tracking_mode: 'OPTIONAL_SERIALIZED' });

  it('grants serial_optional through the SPORTS module, with lot_serial off', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    // Deliberately NO lot_serial — the whole point of the owner decision.
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10.5',
      variantSizeSystem: 'US_MENS',
    });

    const row = insertedRow(stub);
    expect(row.tracking_type).toBe('serial_optional');
    // PAIR arrives from the subcategory profile, as a display convention only.
    expect(row.unit_of_measure).toBe('pair');
  });

  it('refuses a sports category when the sports module is off', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory', 'lot_serial']),
    });
    await expect(
      new InventoryService(ctx).create({
        ...BASE,
        categoryId: 'cat-1',
        variantSize: '10',
        variantSizeSystem: 'US_MENS',
      }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('SERVER-COMPUTES variant_key and ignores anything a caller smuggles in', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10.5',
      variantSizeSystem: 'US_MENS',
      variantWidth: 'D',
      // A forged key. It is not even in CreateItemInput; cast past the type to
      // prove the service never reads one.
      ...({ variantKey: 'size=99' } as Record<string, unknown>),
    });

    const row = insertedRow(stub);
    expect(row.variant_key).toBe('size=10.5|system=us_mens|width=d');
    expect(row.variant_size).toBe('10.5');
    expect(row.variant_size_original).toBe('10.5');
  });

  it('enforces the subcategory required attributes before any write', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await expect(
      // Shoes require size AND size_system.
      new InventoryService(ctx).create({ ...BASE, categoryId: 'cat-1', variantSize: '10' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });

  it('finds-or-creates the group and stamps its id on the item', async () => {
    const stub = buildStub({
      'categories.select': { data: shoesCategory(), error: null },
      // Key lookup misses, then the insert returns the new group.
      'product_groups.select': { data: null, error: null },
      'product_groups.insert': { data: { id: 'grp-new' }, error: null },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
      productGroup: {
        name: 'Nike Pegasus 41',
        brand: 'Nike',
        model: 'Pegasus 41',
        defaultCountingUnit: 'pair',
      },
    });

    expect(insertedRow(stub).group_id).toBe('grp-new');
    // The group key is derived, never supplied.
    const groupInsert = stub.chainArgs.get('product_groups.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(groupInsert.group_key).toBe('shoes|nike|pegasus 41||');
    expect(groupInsert.subcategory_key).toBe('shoes');
  });

  it('refuses a supplied groupId when the sports module is off, whatever the category says', async () => {
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory']),
    });
    await expect(
      new InventoryService(ctx).create({
        ...BASE,
        categoryId: 'cat-1',
        groupId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('does not create a group when the caller already supplied one', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
      groupId: '11111111-1111-1111-1111-111111111111',
    });

    expect(insertedRow(stub).group_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(stub.fromCalls).not.toContain('product_groups');
  });

  it('keeps a jersey number as TEXT with its leading zeroes, never a serial', async () => {
    const stub = buildStub({
      'categories.select': {
        data: categoryRow({ sports_subcategory_key: 'jerseys' }),
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: 'M',
      jerseyNumber: '00',
      playerName: 'Vega',
    });

    const row = insertedRow(stub);
    expect(row.jersey_number).toBe('00');
    expect(row.player_name).toBe('Vega');
    // NUMBERED_VARIANT maps to 'none' — a number is not a serial.
    expect(row.tracking_type).toBe('none');
    expect(row.variant_key).toBe('number=00|size=m');
  });

  it('refuses a tracking-mode override without sports:manage', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, {
      enabledModules: SPORTS_ON,
      role: 'staff',
    });
    await expect(
      new InventoryService(ctx).create({
        ...BASE,
        categoryId: 'cat-1',
        variantSize: '10',
        variantSizeSystem: 'US_MENS',
        trackingModeOverride: 'QUANTITY',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('applies an authorized override to a mode the subcategory allows', async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
      trackingModeOverride: 'QUANTITY',
    });
    expect(insertedRow(stub).tracking_type).toBe('none');
  });

  it('DOWNGRADES a caller-requested serial on a QUANTITY sports category', async () => {
    // The category is the authority in BOTH directions. A shoes category an
    // admin pinned to QUANTITY stamps 'none' even though the caller asked for
    // 'serial' — so a receipt against this item must never demand serials.
    // lot_serial is on only because the TOP gate still reads the caller's own
    // trackingType (deliberately unchanged); the STAMP is what is under test.
    const stub = buildStub({
      'categories.select': {
        data: categoryRow({ sports_subcategory_key: 'shoes', tracking_mode: 'QUANTITY' }),
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['inventory', 'sports', 'lot_serial']),
    });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      trackingType: 'serial',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
    });

    expect(insertedRow(stub).tracking_type).toBe('none');
  });

  it('still stamps from an ARCHIVED category instead of trusting the caller', async () => {
    // Review fix: a soft-deleted category used to read back as "no category",
    // which handed the decision to input.trackingType.
    const stub = buildStub({
      'categories.select': {
        data: categoryRow({
          tracking_mode: 'SERIALIZED',
          deleted_at: '2026-01-01T00:00:00Z',
        }),
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: LOT_SERIAL_ON });
    await new InventoryService(ctx).create({ ...BASE, categoryId: 'cat-1' });

    expect(insertedRow(stub).tracking_type).toBe('serial');
  });

  it('REFUSES a category whose sports_subcategory_key resolves to nothing', async () => {
    const stub = buildStub({
      'categories.select': {
        data: categoryRow({ sports_subcategory_key: 'not_a_subcategory' }),
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await expect(
      new InventoryService(ctx).create({ ...BASE, categoryId: 'cat-1' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });

  it('reads each category ONCE across repeated creates on one service instance', async () => {
    // po-imports builds one InventoryService and loops create() per line.
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE, categoryId: 'cat-1' });
    await svc.create({ ...BASE, categoryId: 'cat-1' });
    await svc.create({ ...BASE, categoryId: 'cat-1' });

    expect(stub.fromCalls.filter((t) => t === 'categories')).toHaveLength(1);
  });
});

describe('InventoryService.create — variant_key on a GROUPED row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes variant_key for a grouped item under a NON-sports category', async () => {
    // Review fix: `groupId` is accepted independently of the category, so a
    // grouped row under a plain category used to land with variant_key = NULL —
    // invisible to product_group_rollups (which counts DISTINCT variant_key)
    // and to the import matcher, which then creates a second variant for the
    // same physical size.
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      groupId: '11111111-1111-1111-1111-111111111111',
      variantSize: 'M',
      variantColor: 'Black',
    });

    const row = insertedRow(stub);
    expect(row.group_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(row.variant_key).toBe('size=m|color=black');
  });

  it('computes variant_key for a grouped item with NO category at all', async () => {
    const stub = buildStub();
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      groupId: '11111111-1111-1111-1111-111111111111',
      variantSize: 'L',
    });

    expect(insertedRow(stub).variant_key).toBe('size=l');
  });

  it("keys a grouped row with no variant attributes as 'default', never NULL", async () => {
    const stub = buildStub();
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      groupId: '11111111-1111-1111-1111-111111111111',
    });

    expect(insertedRow(stub).variant_key).toBe('default');
  });

  it('leaves variant_key NULL for an UNGROUPED non-sports row', async () => {
    // The guard must not widen to every item that happens to carry a size.
    const stub = buildStub({ 'categories.select': { data: categoryRow(), error: null } });
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE, categoryId: 'cat-1', variantSize: 'M' });

    expect(insertedRow(stub).variant_key).toBeNull();
  });
});

describe('InventoryService.create — unit_of_measure precedence', () => {
  beforeEach(() => vi.clearAllMocks());

  const shoesCategory = () => categoryRow({ sports_subcategory_key: 'shoes' });

  it("takes the category's counting unit when the caller omits one", async () => {
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
    });

    expect(insertedRow(stub).unit_of_measure).toBe('pair');
  });

  it("lets an EXPLICIT 'unit' win over the category default", async () => {
    // Review fix: 'unit' used to be read as "unset", so a charter sibling
    // copied off a real 'unit' row silently became 'pair'.
    const stub = buildStub({ 'categories.select': { data: shoesCategory(), error: null } });
    const ctx = makeServiceContext(stub.client, { enabledModules: SPORTS_ON });
    await new InventoryService(ctx).create({
      ...BASE,
      categoryId: 'cat-1',
      unitOfMeasure: 'unit',
      variantSize: '10',
      variantSizeSystem: 'US_MENS',
    });

    expect(insertedRow(stub).unit_of_measure).toBe('unit');
  });

  it("falls back to 'unit' with no category and no caller value", async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));
    await svc.create({ ...BASE });

    expect(insertedRow(stub).unit_of_measure).toBe('unit');
  });
});
