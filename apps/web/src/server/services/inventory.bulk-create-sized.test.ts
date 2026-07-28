import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  // The sized fan-out now stamps tracking_type from the category and gates it
  // exactly as create() does, so the module assertion is on this path too. The
  // dedicated gate tests live in inventory.sports-create.test.ts, which uses
  // the real context module.
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';

const BASE_INPUT = {
  baseName: 'L4L Black T-Shirt',
  baseSku: 'SP-OKX68-UAA',
  baseBarcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 12,
  unitCost: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitOfMeasure: 'unit',
};

/**
 * Builds a Supabase stub that handles two tables:
 *   - inventory_items: the insert that returns the rows back so the
 *     service can hand them to the action.
 *   - stock_movements: the post-insert audit-log writeback. The service
 *     swallows movement-log errors, so an absent table just no-ops here.
 */
function buildStub(
  customFieldDefs: Array<Record<string, unknown>> = [],
  /** Category row backing resolveTrackingProfile. Defaults to a plain category
   *  with no tracking mode and no size scale — every category in every org
   *  today — so the sized-variant path behaves exactly as it always has. */
  categoryRow: Record<string, unknown> | null = {
    id: 'cat-1',
    parent_id: null,
    tracking_mode: null,
    size_scale_id: null,
    default_unit_of_measure: null,
    sports_subcategory_key: null,
    tracking_profile: null,
  },
  /** (value, normalized) rows for the category's size scale, when it has one. */
  sizeScaleValues: Array<{ value: string; normalized: string }> = [],
  /** Ledger-invariant tests: make the stock_movements insert (and optionally
   *  the compensating on-hand rollback) fail. */
  failure: {
    movements?: { message: string; code?: string };
    compensation?: { message: string; code?: string };
    levelCompensation?: { message: string; code?: string };
    /** Simulate a fail-open RLS level write: no error, but the rows survive. */
    levelsSurviveCompensation?: boolean;
  } = {},
) {
  const insertedItems: Array<Record<string, unknown>> = [];
  const insertedMovements: Array<Record<string, unknown>> = [];
  const itemUpdates: Array<Record<string, unknown>> = [];
  const levelUpdates: Array<{ payload: Record<string, unknown>; itemIds: string[] }> = [];
  return {
    insertedItems,
    insertedMovements,
    itemUpdates,
    levelUpdates,

    from(table: string): any {
      if (table === 'categories' || table === 'size_scales' || table === 'size_scale_values') {
        const data =
          table === 'categories'
            ? categoryRow
            : table === 'size_scales'
              ? { id: 'scale-1', size_system: 'US_MENS' }
              : sizeScaleValues;
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          is: () => builder,
          maybeSingle: async () => ({ data, error: null }),
          then: (cb: any) => cb({ data, error: null }),
        };
        return builder;
      }
      if (table === 'custom_field_definitions') {
        // CustomFieldsService.listDefinitions chains
        // .select().eq().eq().eq?().order().order() then awaits the builder.
        // Return a thenable that resolves the configured definition rows so
        // assertCustomFieldsValid can run against the org's registry.
        const result = { data: customFieldDefs, error: null };
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          then: (cb: any) => cb(result),
        };
        return builder;
      }
      if (table === 'inventory_items') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            insertedItems.push(...rows);
            return {
              select: () => ({

                then: (cb: any) =>
                  cb({
                    data: rows.map((r, i) => ({ ...r, id: `i-${i}` })),
                    error: null,
                  }),
              }),
            };
          },
          // The compensating rollback the ledger guard performs when the
          // movement insert fails.
          update: (payload: Record<string, unknown>) => {
            itemUpdates.push(payload);
            let ids: string[] = [];
            const builder: any = {
              eq: () => builder,
              in: (_col: string, v: string[]) => {
                ids = v;
                return builder;
              },
              select: () => builder,
              then: (cb: any) =>
                cb(
                  failure.compensation
                    ? { data: null, error: failure.compensation }
                    : { data: ids.map((id) => ({ id })), error: null },
                ),
            };
            return builder;
          },
        };
      }
      if (table === 'stock_movements') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            insertedMovements.push(...rows);
            return Promise.resolve({ error: failure.movements ?? null });
          },
        };
      }
      // trg_seed_initial_level (mig 0199, AFTER INSERT) has already seeded one
      // level row per stocked item by the time the movement insert runs, and
      // NOTHING syncs levels on UPDATE — so the compensation has to zero these
      // too or the failure path leaves phantom PLACED stock.
      if (table === 'item_stock_levels') {
        const builder: any = {
          update: (payload: Record<string, unknown>) => {
            const w: any = {
              eq: () => w,
              in: (_col: string, ids: string[]) => {
                levelUpdates.push({ payload, itemIds: ids });
                return w;
              },
              select: () => w,
              then: (cb: any) =>
                cb(
                  failure.levelCompensation
                    ? { data: null, error: failure.levelCompensation }
                    : { data: [], error: null },
                ),
            };
            return w;
          },
          // The verification re-read: rows still carrying stock after the
          // compensation. Empty unless the test asks for a fail-open write.
          select: () => {
            const survivors = failure.levelsSurviveCompensation
              ? [{ id: 'lvl-1' }]
              : levelUpdates.length > 0
                ? []
                : [{ id: 'lvl-1' }];
            const r: any = {
              eq: () => r,
              in: () => r,
              gt: () => r,
              then: (cb: any) => cb({ data: survivors, error: null }),
            };
            return r;
          },
        };
        return builder;
      }
      if (table === 'warehouse_charters') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { charter_id: 'ch-1' } }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function makeSvc(stub: ReturnType<typeof buildStub>) {
  return new InventoryService({
     
    supabase: stub as any,
    organizationId: 'org-1',
    userId: 'u1',
    email: 'a@b.c',
    role: 'admin',
     
  } as any);
}

describe('InventoryService.bulkCreateSizedVariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts one row per size with name + sku + custom_fields.size suffixed', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    const res = await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: 'S', quantity: 3 },
        { size: 'M', quantity: 5 },
      ],
    });

    expect(stub.insertedItems).toHaveLength(2);
    expect(stub.insertedItems[0]?.name).toBe('L4L Black T-Shirt - S');
    expect(stub.insertedItems[0]?.sku).toBe('SP-OKX68-UAA-S');
    expect(stub.insertedItems[0]?.quantity_on_hand).toBe(3);
    expect(stub.insertedItems[0]?.unit_of_measure).toBe('unit');
    expect(stub.insertedItems[0]?.charter_id).toBeNull();
    expect((stub.insertedItems[0]?.custom_fields as Record<string, unknown>).size).toBe('S');
    expect(stub.insertedItems[1]?.name).toBe('L4L Black T-Shirt - M');
    expect(stub.insertedItems[1]?.sku).toBe('SP-OKX68-UAA-M');
    expect(res).toHaveLength(2);
  });

  it('writes stock_movements for non-zero variants only', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: 'S', quantity: 0 },
        { size: 'M', quantity: 4 },
      ],
    });

    expect(stub.insertedMovements).toHaveLength(1);
    expect(stub.insertedMovements[0]?.quantity_change).toBe(4);
    expect(stub.insertedMovements[0]?.movement_type).toBe('initial');
  });

  it('throws when variants is empty', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);
    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [],
      }),
    ).rejects.toThrow(/at least one size/i);
  });

  it('null baseSku auto-generates a shared base and suffixes per variant', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);
    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      baseSku: null,
      variants: [
        { size: 'L', quantity: 1 },
        { size: 'XL', quantity: 2 },
      ],
    });
    const skuL = stub.insertedItems[0]?.sku as string;
    const skuXL = stub.insertedItems[1]?.sku as string;
    expect(typeof skuL).toBe('string');
    expect(skuL.endsWith('-L')).toBe(true);
    expect(skuXL.endsWith('-XL')).toBe(true);
    // Both variants share the SAME generated base.
    expect(skuL.replace(/-L$/, '')).toBe(skuXL.replace(/-XL$/, ''));
  });

  it('applies per-org customFields to every variant alongside the reserved size key', async () => {
    const stub = buildStub([
      {
        id: 'd1',
        organization_id: 'org-1',
        entity: 'item',
        field_key: 'material',
        label: 'Material',
        field_type: 'text',
        options: null,
        required: false,
        sort_order: 0,
        archived: false,
      },
    ]);
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      customFields: { material: 'cotton' },
      variants: [
        { size: 'S', quantity: 1 },
        { size: 'M', quantity: 2 },
      ],
    });

    expect(stub.insertedItems).toHaveLength(2);
    for (const item of stub.insertedItems) {
      const cf = item.custom_fields as Record<string, unknown>;
      expect(cf.material).toBe('cotton');
    }
    expect((stub.insertedItems[0]?.custom_fields as Record<string, unknown>).size).toBe('S');
    expect((stub.insertedItems[1]?.custom_fields as Record<string, unknown>).size).toBe('M');
  });

  it('strips reserved keys from customFields so they cannot clobber size/rack', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      // A crafted payload trying to override the reserved variant keys.
      customFields: { size: 'HACK', rack_number: '99', material: 'wool' },
      variants: [{ size: 'L', quantity: 1 }],
    });

    const cf = stub.insertedItems[0]?.custom_fields as Record<string, unknown>;
    // Reserved keys win (size from the variant), stray reserved key dropped...
    expect(cf.size).toBe('L');
    expect(cf.rack_number).toBeUndefined();
    // ...but a non-reserved org key with no definition flows through untouched.
    expect(cf.material).toBe('wool');
  });

  // ── Sports (Task 8): first-class variant columns on the sized-variant path ──

  it('stamps variant_size / _original / variant_key alongside the legacy custom_fields.size', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: 'xl', quantity: 2 }],
    });

    const row = stub.insertedItems[0]!;
    // Normalized for MATCHING, original preserved verbatim.
    expect(row.variant_size).toBe('XL');
    expect(row.variant_size_original).toBe('xl');
    expect(row.variant_key).toBe('size=xl');
    expect(row.group_id).toBeNull();
    // The legacy reader has not moved yet — both are written (Task 19 retires
    // the custom_fields copy).
    expect((row.custom_fields as Record<string, unknown>).size).toBe('xl');
  });

  it('accepts a size the old nine-value enum could not express', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: '10.5', quantity: 1 },
        { size: '11', quantity: 1 },
      ],
    });

    expect(stub.insertedItems.map((r) => r.variant_size)).toEqual(['10.5', '11']);
    expect(stub.insertedItems.map((r) => r.variant_key)).toEqual(['size=10.5', 'size=11']);
  });

  it('rejects a size the category size scale does not contain', async () => {
    const stub = buildStub(
      [],
      {
        id: 'cat-1',
        parent_id: null,
        tracking_mode: null,
        size_scale_id: 'scale-1',
        default_unit_of_measure: null,
        sports_subcategory_key: 'shoes',
        tracking_profile: null,
      },
      [
        { value: '10', normalized: '10' },
        { value: '10.5', normalized: '10.5' },
      ],
    );
    const svc = makeSvc(stub);

    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [
          { size: '10', quantity: 1 },
          { size: '99', quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/not a size in this category's size scale/i);
    expect(stub.insertedItems).toHaveLength(0);
  });

  it('stamps the size system from the category scale when there is one', async () => {
    const stub = buildStub(
      [],
      {
        id: 'cat-1',
        parent_id: null,
        tracking_mode: null,
        size_scale_id: 'scale-1',
        default_unit_of_measure: null,
        sports_subcategory_key: 'shoes',
        tracking_profile: null,
      },
      [{ value: '10', normalized: '10' }],
    );
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: 'US 10', quantity: 1 }],
    });

    const row = stub.insertedItems[0]!;
    expect(row.variant_size_system).toBe('US_MENS');
    // The redundant system prefix is stripped for matching, kept verbatim in
    // _original. NEVER converted between systems.
    expect(row.variant_size).toBe('10');
    expect(row.variant_size_original).toBe('US 10');
    expect(row.variant_key).toBe('size=10|system=us_mens');
  });

  it("stamps tracking_type from the category instead of hardcoding 'none'", async () => {
    // Review fix: this fan-out is the sized-apparel twin of create(), so a
    // SERIALIZED (or OPTIONAL_SERIALIZED) category producing untracked rows
    // here while create() produced tracked ones gave the same physical product
    // two different receive-time contracts.
    const stub = buildStub([], {
      id: 'cat-1',
      parent_id: null,
      tracking_mode: 'OPTIONAL_SERIALIZED',
      // Shoes REQUIRE a size system, and on this path it is derived from the
      // category's size scale — the sized fan-out now runs the subcategory's
      // attribute rules exactly as create() does (Task 11 review fix), so a
      // shoes fixture has to carry the scale its profile demands.
      size_scale_id: 'scale-1',
      default_unit_of_measure: null,
      sports_subcategory_key: 'shoes',
      tracking_profile: null,
      deleted_at: null,
    });
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: '10', quantity: 1 }],
    });

    expect(stub.insertedItems[0]?.tracking_type).toBe('serial_optional');
  });

  it("still writes tracking_type 'none' for a category with no policy", async () => {
    // Every category in every org today — the path is byte-identical.
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: 'M', quantity: 1 }],
    });

    expect(stub.insertedItems[0]?.tracking_type).toBe('none');
  });

  it("takes the category's counting unit when the caller omits unitOfMeasure", async () => {
    const stub = buildStub([], {
      id: 'cat-1',
      parent_id: null,
      tracking_mode: null,
      // See above: a shoes profile requires a size system, which this path
      // derives from the scale.
      size_scale_id: 'scale-1',
      default_unit_of_measure: null,
      sports_subcategory_key: 'shoes',
      tracking_profile: null,
      deleted_at: null,
    });
    const svc = makeSvc(stub);

    const { unitOfMeasure: _omitted, ...noUom } = BASE_INPUT;
    await svc.bulkCreateSizedVariants({ ...noUom, variants: [{ size: '10', quantity: 1 }] });

    expect(stub.insertedItems[0]?.unit_of_measure).toBe('pair');
  });

  it('rejects the same size listed twice instead of creating two identical variants', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [
          { size: 'M', quantity: 1 },
          { size: 'm', quantity: 2 },
        ],
      }),
    ).rejects.toThrow(/listed twice/i);
    expect(stub.insertedItems).toHaveLength(0);
  });

  it('rejects a blank size', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);
    await expect(
      svc.bulkCreateSizedVariants({ ...BASE_INPUT, variants: [{ size: '   ', quantity: 1 }] }),
    ).rejects.toThrow(/needs a size/i);
  });

  it('enforces a REQUIRED custom field on the sized-variant path (rejects, no write)', async () => {
    const stub = buildStub([
      {
        id: 'd1',
        organization_id: 'org-1',
        entity: 'item',
        field_key: 'material',
        label: 'Material',
        field_type: 'text',
        options: null,
        required: true,
        sort_order: 0,
        archived: false,
      },
    ]);
    const svc = makeSvc(stub);

    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        // Required `material` omitted -> the authoritative gate must reject.
        customFields: { other: 'x' },
        variants: [{ size: 'S', quantity: 1 }],
      }),
    ).rejects.toThrow(/required/i);
    expect(stub.insertedItems).toHaveLength(0);
  });
});

// THE LEDGER INVARIANT IS ABSOLUTE: SUM(stock_movements.quantity_change) for an
// item equals its quantity_on_hand. This path used to console.warn a failed
// movement insert and return SUCCESS, leaving rows carrying stock that no
// movement anywhere explains — invisible to the item Activity feed, to the
// 14-day sparklines and to every reconciliation that sums the ledger, and
// silently understating what a later restore or audit would rebuild.
describe('InventoryService.bulkCreateSizedVariants — movement-insert failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT report success when the opening movements could not be written', async () => {
    const stub = buildStub([], undefined, [], { movements: { message: 'ledger down' } });
    await expect(
      makeSvc(stub).bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [{ size: 'S', quantity: 3 }],
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('COMPENSATES by zeroing the on-hand it could not explain, restoring 0 = 0', async () => {
    const stub = buildStub([], undefined, [], { movements: { message: 'ledger down' } });
    await makeSvc(stub)
      .bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [
          { size: 'S', quantity: 3 },
          { size: 'M', quantity: 0 },
        ],
      })
      .catch(() => undefined);

    expect(stub.itemUpdates).toHaveLength(1);
    expect(stub.itemUpdates[0]?.quantity_on_hand).toBe(0);
  });

  // trg_seed_initial_level (0199) fires AFTER INSERT on inventory_items and has
  // ALREADY written one item_stock_levels row per stocked variant by the time
  // the movement insert is attempted. Nothing syncs levels on UPDATE, so zeroing
  // only quantity_on_hand left SUM(levels) = N against on_hand = 0: phantom
  // PLACED stock that blocks the archive stock-guard (which takes
  // max(on_hand, Σholdings)) and is pickable straight into negative on-hand.
  it('also zeroes the item_stock_levels rows the 0199 trigger already seeded', async () => {
    const stub = buildStub([], undefined, [], { movements: { message: 'ledger down' } });
    await makeSvc(stub)
      .bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [
          { size: 'S', quantity: 3 },
          { size: 'M', quantity: 0 },
        ],
      })
      .catch(() => undefined);

    expect(stub.levelUpdates).toHaveLength(1);
    expect(stub.levelUpdates[0]?.payload.quantity).toBe(0);
    // Scoped to exactly the variants that were seeded — the zero-quantity one
    // never got a level row and must not be touched.
    expect(stub.levelUpdates[0]?.itemIds).toEqual(['i-0']);
  });

  it('fails loudly when the seeded placements could not be zeroed', async () => {
    const stub = buildStub([], undefined, [], {
      movements: { message: 'ledger down' },
      levelCompensation: { message: 'levels down' },
    });
    const err = (await makeSvc(stub)
      .bulkCreateSizedVariants({ ...BASE_INPUT, variants: [{ size: 'S', quantity: 3 }] })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).toMatch(/support/i);
  });

  it('VERIFIES the placements are gone — a fail-open RLS write is not success', async () => {
    // .update().eq() reports success when RLS matched nothing, so the
    // compensation is proven by a re-read, not by the absence of an error.
    const stub = buildStub([], undefined, [], {
      movements: { message: 'ledger down' },
      levelsSurviveCompensation: true,
    });
    const err = (await makeSvc(stub)
      .bulkCreateSizedVariants({ ...BASE_INPUT, variants: [{ size: 'S', quantity: 3 }] })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).toMatch(/support/i);
  });

  it('never touches item_stock_levels when the movements DID land', async () => {
    const stub = buildStub();
    await makeSvc(stub).bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: 'S', quantity: 3 }],
    });
    expect(stub.levelUpdates).toHaveLength(0);
  });

  it('says so loudly when even the rollback fails, instead of swallowing both', async () => {
    const stub = buildStub([], undefined, [], {
      movements: { message: 'ledger down' },
      compensation: { message: 'rollback down' },
    });
    const err = (await makeSvc(stub)
      .bulkCreateSizedVariants({ ...BASE_INPUT, variants: [{ size: 'S', quantity: 3 }] })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).toMatch(/support/i);
  });

  it('never compensates when the movements DID land', async () => {
    const stub = buildStub();
    await makeSvc(stub).bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [{ size: 'S', quantity: 3 }],
    });
    expect(stub.itemUpdates).toHaveLength(0);
  });
});
