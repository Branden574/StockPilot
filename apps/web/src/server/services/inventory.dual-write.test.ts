// InventoryService.update() must keep variant_size and custom_fields.size in
// lockstep for the length of the 0303 transition window.
//
// WHY BOTH: variant_size is the durable, indexed column the group roll-up and
// the PO-import matcher read. custom_fields.size is the shape every row
// bulkCreateSizedVariants ever wrote still carries, and it is the source
// migration 0303's backfill copies from — and the source its rollback restores
// from. If update() wrote only one of them, a size edited on the item form
// would disagree with the size a re-run of the backfill recovers, and which of
// the two a given surface believed would depend on which surface it was.
//
// Before 0303, update() ignored patch.variantSize altogether: a size edit on
// the item form was accepted by the form, validated by zod, and then silently
// dropped. Several of these tests are the regression for that.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
// variant_size is a SHARED_ITEM_FIELD now (Model B: a variant's identity is a
// product fact, not a per-rack one), so a size edit takes the sibling fan-out
// and that runs on the service-role client. Stubbed to a no-op: WHICH client
// the fan-out uses is proven in inventory.shared-field-propagation.test.ts.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['update', 'eq', 'is', 'neq', 'select']) chain[m] = () => chain;
    (chain as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: null, error: null });
    return { from: () => chain };
  }),
}));

import { InventoryService } from './inventory';

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-1',
  sku: 'TEE-XL',
  barcode: null,
  name: 'Team Shirt - XL',
  warehouse_id: null,
  bin_location: null,
  charter_id: null,
  // The pre-0303 shape: the size lives ONLY in custom_fields, alongside an
  // unrelated sibling key that must survive every write below.
  custom_fields: { size: 'XL', rack_number: '22' },
  status: 'active',
  item_type: 'product',
  tracking_type: 'none',
  quantity_on_hand: 5,
  group_id: null,
  variant_size: 'XL',
  variant_size_original: 'XL',
  variant_size_system: null,
  variant_width: null,
  variant_fit: null,
  variant_color: null,
  jersey_number: null,
  player_name: null,
};

/**
 * Captures every payload handed to `.update()` on inventory_items. update()
 * issues the main row UPDATE and may then issue a variant_key recompute and a
 * Model B sibling fan-out, so the tests assert against `updates[0]` (the row
 * write) and inspect the rest by hand.
 */
function makeCtx(item: Record<string, unknown> = ITEM) {
  const updates: Array<Record<string, unknown>> = [];
  const supabase = {
    from: (table: string) => {
      const p: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'neq', 'order', 'limit']) {
        p[m] = () => p;
      }
      if (table !== 'inventory_items') {
        p.update = () => p;
        p.single = async () => ({ data: null, error: null });
        p.maybeSingle = async () => ({ data: null, error: null });
        (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res({ data: [], error: null });
        return p;
      }
      let isUpdate = false;
      p.update = (payload: Record<string, unknown>) => {
        updates.push(payload);
        isUpdate = true;
        return p;
      };
      const result = { data: item, error: null };
      p.single = async () => (isUpdate ? result : result);
      p.maybeSingle = async () => result;
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res(isUpdate ? result : { data: [item], error: null });
      return p;
    },
  };
  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;
  return { ctx, updates };
}

/** The main row write is always the first `.update()` on inventory_items. */
const rowWrite = (updates: Array<Record<string, unknown>>) => updates[0] ?? {};

describe('InventoryService.update — variant_size / custom_fields.size dual-write (0303)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes BOTH places when variantSize is patched', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('L');
    expect(w.custom_fields).toMatchObject({ size: 'L' });
  });

  it('keeps unrelated custom_fields keys when it writes the size', async () => {
    // The rack stamp is stored in the same jsonb. A dual-write that replaced
    // the object instead of merging would silently un-rack the item.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    expect(rowWrite(updates).custom_fields).toEqual({ size: 'L', rack_number: '22' });
  });

  it('records variant_size_original, defaulting it to the size when none is given', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });
    expect(rowWrite(updates).variant_size_original).toBe('L');
  });

  it('keeps an explicitly supplied variant_size_original verbatim', async () => {
    // The normalized form goes in variant_size; what the human/import actually
    // typed goes in the original and is never cleaned up (0298's contract).
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', {
      variantSize: 'L',
      variantSizeOriginal: '  large  ',
    });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('L');
    expect(w.variant_size_original).toBe('  large  ');
  });

  it('merges the size onto custom_fields edited in the SAME patch', async () => {
    // The item form always submits customFields alongside the rest of the
    // form. Merging onto the STORED object here instead of the patched one
    // would revert whatever the user just changed in the custom-field inputs.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', {
      variantSize: 'L',
      customFields: { rack_number: '31', warranty: '2y' },
    });

    expect(rowWrite(updates).custom_fields).toEqual({
      rack_number: '31',
      warranty: '2y',
      size: 'L',
    });
  });

  it('leaves BOTH places alone when the patch does not mention the size', async () => {
    // A per-placement field, deliberately: a SHARED_ITEM_FIELDS edit would take
    // the Model B sibling fan-out, which needs a service-role client this unit
    // test has no business standing up.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { binLocation: 'A-1' });

    const w = rowWrite(updates);
    expect(w.bin_location).toBe('A-1');
    expect('variant_size' in w).toBe(false);
    expect('variant_size_original' in w).toBe(false);
    expect('custom_fields' in w).toBe(false);
  });

  it('nulls the column when the size is cleared, and leaves custom_fields.size for the reader migration', async () => {
    // Deliberate asymmetry. custom_fields.size is the only surviving record of
    // what the size WAS and 0303's rollback statement depends on it, so
    // clearing the column never deletes the key. The reader migration retires
    // it wholesale, once.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: null });

    const w = rowWrite(updates);
    expect(w.variant_size).toBeNull();
    expect(w.variant_size_original).toBeNull();
    expect('custom_fields' in w).toBe(false);
  });

  it('recomputes variant_key when the size actually moves', async () => {
    // A stale variant_key points the import matcher at the OLD size, which is
    // how a second variant gets created for a size that already exists.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    expect(updates.some((u) => 'variant_key' in u)).toBe(true);
  });

  it('does NOT recompute variant_key when the patched size equals the stored one', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'XL' });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('XL');
    expect(updates.some((u) => 'variant_key' in u)).toBe(false);
  });

  it('does NOT re-record variant_size_original when the submitted size is unchanged', async () => {
    // The edit form now seeds the row's stored size, so EVERY save re-submits
    // it — including saves that only meant to move the item's rack.
    // variant_size_original is the VERBATIM source 0303 copied out of
    // custom_fields ('  xl  '), and rewriting it with the normalized column
    // value would destroy the audit trail the rollback statement reads.
    // (binLocation, not a SHARED_ITEM_FIELD — see the test below.)
    const verbatim = { ...ITEM, variant_size: 'XL', variant_size_original: '  xl  ' };
    const { ctx, updates } = makeCtx(verbatim);
    await new InventoryService(ctx).update('itm-1', { variantSize: 'XL', binLocation: 'A-1' });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('XL');
    expect('variant_size_original' in w).toBe(false);
    expect(w.bin_location).toBe('A-1');
  });

  it('DOES re-record variant_size_original when the size moves', async () => {
    // The other half: the original tracks the source of the CURRENT size, so a
    // real size edit must not leave the previous row's verbatim value behind.
    const verbatim = { ...ITEM, variant_size: 'XL', variant_size_original: '  xl  ' };
    const { ctx, updates } = makeCtx(verbatim);
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    expect(rowWrite(updates).variant_size_original).toBe('L');
  });

  it('back-fills the column for a legacy row that only ever had custom_fields.size', async () => {
    // The row 0303 exists for: created before the variant columns did. An edit
    // must bring it fully forward, not half.
    const legacy = { ...ITEM, variant_size: null, variant_size_original: null };
    const { ctx, updates } = makeCtx(legacy);
    await new InventoryService(ctx).update('itm-1', { variantSize: 'XL' });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('XL');
    expect(w.variant_size_original).toBe('XL');
    expect(w.custom_fields).toMatchObject({ size: 'XL' });
    expect(updates.some((u) => 'variant_key' in u)).toBe(true);
  });

  it('never touches group_id — grouping stays opt-in even on a size edit', async () => {
    // The same anti-inference rule the backfill obeys. Nothing about editing a
    // size tells us which family the item belongs to.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    for (const u of updates) expect('group_id' in u).toBe(false);
  });

  it('never touches quantity_on_hand or writes a movement', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });

    for (const u of updates) expect('quantity_on_hand' in u).toBe(false);
  });
});

// The bulk and import paths have always run the typed size through
// normalizeSizeValue before it reaches a column or a key. create() and update()
// did not, so '  l  ' typed on the item form persisted verbatim and minted
// `size=  l  ` while the same shoe arriving on a PO minted `size=l`. Two keys,
// one physical size, and the import matcher creating a second variant for it.
describe('InventoryService.update — size normalization (parity with the bulk path)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes the patched size into the column', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '  l  ' });
    expect(rowWrite(updates).variant_size).toBe('L');
  });

  it('keeps the RAW typed text in variant_size_original', async () => {
    // 0298's contract: the original is what a human or an import actually
    // typed, and it is never cleaned up.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '  l  ' });
    expect(rowWrite(updates).variant_size_original).toBe('  l  ');
  });

  it('mints the key off the NORMALIZED size, so both paths agree', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '  l  ' });
    expect(rowWrite(updates).variant_key).toBe('size=l');
  });

  it("drops a numeric size's trailing .0 exactly as the bulk path does", async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '10.0' });
    expect(rowWrite(updates).variant_size).toBe('10');
  });

  it('writes the normalized size to custom_fields.size too, so the two never disagree', async () => {
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '  l  ' });
    expect(rowWrite(updates).custom_fields).toMatchObject({ size: 'L' });
  });

  it('treats a size that normalizes to the STORED value as no change at all', async () => {
    // ITEM.variant_size is 'XL'. Re-submitting '  xl  ' is the same size, so
    // neither the original nor the key may be rewritten.
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: '  xl  ' });

    const w = rowWrite(updates);
    expect(w.variant_size).toBe('XL');
    expect('variant_size_original' in w).toBe(false);
    expect('variant_key' in w).toBe(false);
  });

  it('leaves variant_size_system alone when the resolved system already matches', async () => {
    // No category, no scale, stored system null → nothing to write. The column
    // is only touched when the key would otherwise carry a system the row does
    // not have (recomputeVariantKey rebuilds from the columns).
    const { ctx, updates } = makeCtx();
    await new InventoryService(ctx).update('itm-1', { variantSize: 'L' });
    expect('variant_size_system' in rowWrite(updates)).toBe(false);
  });

  it('refuses a size longer than the DB check allows, before any write', async () => {
    const { ctx, updates } = makeCtx();
    await expect(
      new InventoryService(ctx).update('itm-1', { variantSize: 'X'.repeat(25) }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(updates).toHaveLength(0);
  });
});
