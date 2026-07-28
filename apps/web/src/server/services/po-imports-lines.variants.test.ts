import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroupKey, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: mockAudit }));

import { createItemsFromPoLines } from './po-imports-lines';

/**
 * Task 14 — the CREATE path is where a resolution becomes an item.
 *
 * The resolver itself is unit-tested in po-imports-variants.test.ts; what is
 * asserted here is the wiring: the resolved group and the variant attributes
 * reach `InventoryService.create`, a blocked line is REFUSED rather than
 * quietly created, and an explicit human decision (and only that) turns a
 * suggestion into a link.
 */

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';

function shoeLine(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    po_import_id: IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    description: 'Nike Pegasus 41',
    qty_ordered_original: 6,
    uom_original: 'PAIR',
    unit_cost: 90,
    vendor_item_number: null,
    vendor_product_number: 'FD2722',
    auxiliary_number: null,
    item_id: null,
    variant_size: '10',
    variant_size_original: 'US 10',
    variant_size_system: 'US_MENS',
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_hint: 'Nike Pegasus 41',
    suggested_group_id: null,
    mapping_confidence: null,
    ...over,
  };
}

function shoeGroupRow() {
  return {
    id: GROUP_ID,
    organization_id: 'org-test',
    category_id: CATEGORY_ID,
    subcategory_key: 'shoes',
    name: 'Nike Pegasus 41',
    brand: null,
    manufacturer: null,
    model: 'Nike Pegasus 41',
    style_number: 'FD2722',
    colorway: null,
    team: null,
    league: null,
    season: null,
    home_away: null,
    color: null,
    size_scale_id: null,
    default_counting_unit: 'pair',
    tracking_mode: null,
    group_key: buildGroupKey({
      subcategoryKey: 'shoes',
      model: 'Nike Pegasus 41',
      styleNumber: 'FD2722',
    }),
    status: 'active',
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
  };
}

/**
 * The create path reads `categories` (tracking profile), `product_groups`
 * (identity) and `inventory_items` (variants). Each is served here in the
 * order the service issues them.
 */
function stubFor(options: {
  line?: Record<string, unknown>;
  sportsCategory?: boolean;
  groupHit?: boolean;
  groupCandidates?: Array<Record<string, unknown>>;
  variants?: Array<Record<string, unknown>>;
}) {
  const category = options.sportsCategory
    ? {
        id: CATEGORY_ID,
        parent_id: null,
        tracking_mode: null,
        size_scale_id: null,
        default_unit_of_measure: 'pair',
        sports_subcategory_key: 'shoes',
        tracking_profile: null,
        deleted_at: null,
      }
    : null;

  let groupSelectCall = 0;
  return makeSupabaseStub({
    'po_imports.select': { data: { id: IMPORT_ID, status: 'parsed' }, error: null },
    'po_import_lines.select': { data: [options.line ?? shoeLine()], error: null },
    'po_import_lines.update': { data: [{ id: LINE_ID }], error: null },
    'locations.select': { data: null, error: null },
    'charters.select': { data: null, error: null },
    'categories.select': { data: category, error: null },
    'product_groups.select': () => {
      // 1st = findByKey (maybeSingle), 2nd = candidates (list).
      groupSelectCall++;
      if (groupSelectCall === 1) {
        return { data: options.groupHit ? shoeGroupRow() : null, error: null };
      }
      return { data: options.groupCandidates ?? [], error: null };
    },
    'inventory_items.select': { data: options.variants ?? [], error: null },
  });
}

function ctxFor(stub: ReturnType<typeof makeSupabaseStub>) {
  return makeServiceContext(stub.client, {
    organizationId: 'org-test',
    role: 'admin',
    enabledModules: new Set<ModuleId>(['inventory', 'po_imports', 'sports']),
  });
}

function depsFor(stub: ReturnType<typeof makeSupabaseStub>) {
  const create = vi.fn(async (_input: Record<string, unknown>) => ({ id: 'item-new' }));
  const ctx = ctxFor(stub);
  return {
    create,
    deps: {
      supabase: stub.client,
      organizationId: 'org-test',
      inventorySvc: { create } as never,
      mappingsSvc: { upsert: vi.fn(async () => {}) } as never,
      ctx,
    },
  };
}

const BASE_INPUT = {
  poImportId: IMPORT_ID,
  lineIds: [LINE_ID],
  vendorId: VENDOR_ID,
  warehouseId: WAREHOUSE_ID,
};

beforeEach(() => vi.clearAllMocks());

describe('createItemsFromPoLines — sports identity', () => {
  it('creates the item under the exactly-matched group, with the variant attributes', async () => {
    const stub = stubFor({ sportsCategory: true, groupHit: true });
    const { create, deps } = depsFor(stub);

    const r = await createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID });

    expect(r.created).toBe(1);
    const arg = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.groupId).toBe(GROUP_ID);
    expect(arg.categoryId).toBe(CATEGORY_ID);
    expect(arg.variantSize).toBe('10');
    expect(arg.variantSizeSystem).toBe('US_MENS');
    // The document's own text survives the normalized value.
    expect(arg.variantSizeOriginal).toBe('US 10');
    // variant_key is NEVER passed in — create() derives it server-side.
    expect(arg).not.toHaveProperty('variantKey');
  });

  it('leaves a non-sports import byte-identical: no group, no variant fields set', async () => {
    const stub = stubFor({ sportsCategory: false });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, BASE_INPUT);

    const arg = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.groupId).toBeNull();
    expect(arg.categoryId).toBeNull();
    // No product_groups read happened at all.
    expect(stub.fromCalls).not.toContain('product_groups');
  });

  it('REFUSES a line whose group is ambiguous, and creates nothing', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: false,
      groupCandidates: [
        { ...shoeGroupRow(), id: 'grp-a', name: 'A' },
        { ...shoeGroupRow(), id: 'grp-b', name: 'B' },
      ],
    });
    const { create, deps } = depsFor(stub);

    await expect(
      createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID }),
    ).rejects.toThrow(/Several existing product groups match/);
    expect(create).not.toHaveBeenCalled();
  });

  it('REFUSES a possible duplicate until a human decides — a suggestion is not a link', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: false,
      groupCandidates: [{ ...shoeGroupRow(), id: GROUP_ID, name: 'Nike Pegasus 41' }],
    });
    const { create, deps } = depsFor(stub);

    await expect(
      createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID }),
    ).rejects.toThrow(/An existing group looks like this one/);
    expect(create).not.toHaveBeenCalled();
  });

  it('links the candidate ONLY on an explicit decision, and audits the override', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: false,
      groupCandidates: [{ ...shoeGroupRow(), id: GROUP_ID, name: 'Nike Pegasus 41' }],
    });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, {
      ...BASE_INPUT,
      categoryId: CATEGORY_ID,
      groupDecisions: { [LINE_ID]: { mode: 'link', groupId: GROUP_ID } },
    });

    expect((create.mock.calls[0]?.[0] as Record<string, unknown>).groupId).toBe(GROUP_ID);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sports.import.match_overridden' }),
      expect.anything(),
    );
  });

  it('refuses to link a group that was not one of the line’s candidates', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: false,
      groupCandidates: [{ ...shoeGroupRow(), id: GROUP_ID, name: 'Nike Pegasus 41' }],
    });
    const { create, deps } = depsFor(stub);

    await expect(
      createItemsFromPoLines(deps, {
        ...BASE_INPUT,
        categoryId: CATEGORY_ID,
        groupDecisions: {
          [LINE_ID]: { mode: 'link', groupId: '77777777-7777-4777-8777-777777777777' },
        },
      }),
    ).rejects.toThrow(/not one of this line/);
    expect(create).not.toHaveBeenCalled();
  });

  it('honours "confirm a new group" by creating with no group id', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: false,
      groupCandidates: [{ ...shoeGroupRow(), id: GROUP_ID, name: 'Nike Pegasus 41' }],
    });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, {
      ...BASE_INPUT,
      categoryId: CATEGORY_ID,
      groupDecisions: { [LINE_ID]: { mode: 'new' } },
    });

    expect((create.mock.calls[0]?.[0] as Record<string, unknown>).groupId).toBeNull();
  });

  it('blocks a low-confidence mapping, and no group decision can wave it through', async () => {
    const stub = stubFor({
      sportsCategory: true,
      line: shoeLine({ mapping_confidence: 0.4 }),
    });
    const { create, deps } = depsFor(stub);

    await expect(
      createItemsFromPoLines(deps, {
        ...BASE_INPUT,
        categoryId: CATEGORY_ID,
        groupDecisions: { [LINE_ID]: { mode: 'new' } },
      }),
    ).rejects.toThrow(/Confirm what the ambiguous column/);
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks a shoe line with no size, and accepts the reviewer’s inline fix', async () => {
    const blocked = stubFor({
      sportsCategory: true,
      groupHit: true,
      line: shoeLine({ variant_size: null, variant_size_original: null }),
    });
    const first = depsFor(blocked);
    await expect(
      createItemsFromPoLines(first.deps, { ...BASE_INPUT, categoryId: CATEGORY_ID }),
    ).rejects.toThrow(/no size/);

    const fixed = stubFor({
      sportsCategory: true,
      groupHit: true,
      line: shoeLine({ variant_size: null, variant_size_original: null }),
    });
    const second = depsFor(fixed);
    await createItemsFromPoLines(second.deps, {
      ...BASE_INPUT,
      categoryId: CATEGORY_ID,
      variantOverrides: { [LINE_ID]: { size: '11', sizeSystem: 'US_MENS' } },
    });
    const arg = second.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.variantSize).toBe('11');
  });

  it('receives into an existing variant instead of creating a second one for the same key', async () => {
    const stub = stubFor({
      sportsCategory: true,
      groupHit: true,
      // variantsByKey returns one row; the sibling/charter lookup then reads
      // the same table and finds the item, so the line LINKS.
      variants: [
        {
          id: 'item-existing',
          name: 'Pegasus 41 US10',
          sku: 'SKU-1',
          barcode: null,
          charter_id: null,
          unit_cost: 90,
          retail_price: 0,
          category_id: CATEGORY_ID,
          supplier_id: VENDOR_ID,
          warehouse_id: WAREHOUSE_ID,
          unit_of_measure: 'pair',
          item_type: 'product',
          tracking_type: 'none',
          group_id: GROUP_ID,
          variant_size: '10',
          variant_size_original: 'US 10',
          variant_size_system: 'US_MENS',
          variant_width: null,
          variant_fit: null,
          variant_color: null,
          jersey_number: null,
          player_name: null,
        },
      ],
    });
    const { create, deps } = depsFor(stub);

    const r = await createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID });

    expect(r.linked).toBe(1);
    expect(r.created).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('createItemsFromPoLines — "new" never discards an exact group match', () => {
  it('keeps the matched group when the reviewer adds a NEW variant to it', async () => {
    // Two variants already share the resolved variant key, so the verdict is
    // ambiguous_variant_match on a group that WAS matched exactly.
    const stub = stubFor({
      sportsCategory: true,
      groupHit: true,
      variants: [
        { id: 'itm-a', name: 'Pegasus 41 US 10', sku: 'SKU-A' },
        { id: 'itm-b', name: 'Pegasus 41 US 10', sku: 'SKU-B' },
      ],
    });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, {
      ...BASE_INPUT,
      categoryId: CATEGORY_ID,
      groupDecisions: { [LINE_ID]: { mode: 'new' } },
    });

    // 'new' means "not one of those variants", NOT "forget the group". Losing
    // it here created an orphan variant of a product the org already has.
    expect((create.mock.calls[0]?.[0] as Record<string, unknown>).groupId).toBe(GROUP_ID);
    // ...and with a group already resolved there is nothing to find-or-create.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('productGroup');
  });

  it('threads the group IDENTITY when the line must create one', async () => {
    const stub = stubFor({ sportsCategory: true, groupHit: false });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID });

    const arg = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.groupId).toBeNull();
    // Without this, create() skipped find-or-create entirely and every
    // create_new_group line landed group_id = NULL.
    expect(arg.productGroup).toMatchObject({
      name: 'Nike Pegasus 41',
      subcategoryKey: 'shoes',
      model: 'Nike Pegasus 41',
      styleNumber: 'FD2722',
      categoryId: CATEGORY_ID,
    });
  });

  it('passes NO group identity for a non-sports import', async () => {
    const stub = stubFor({ sportsCategory: false });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, BASE_INPUT);

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('productGroup');
  });
});

// ---------------------------------------------------------------------------
// Final-review wave C: variant columns are SPORTS columns. The scan extractor
// reads a size or a colour off any document, so persisting them unconditionally
// stamped sports identity onto inventory_items rows in orgs with no sports
// module — no screen to show them, none to edit them, none to unwind them.
// ---------------------------------------------------------------------------

describe('createItemsFromPoLines — variant persistence is module-gated', () => {
  /** The same deps, with the sports module OFF. */
  function nonSportsDeps(stub: ReturnType<typeof makeSupabaseStub>) {
    const create = vi.fn(async (_input: Record<string, unknown>) => ({ id: 'item-new' }));
    return {
      create,
      deps: {
        supabase: stub.client,
        organizationId: 'org-test',
        inventorySvc: { create } as never,
        mappingsSvc: { upsert: vi.fn(async () => {}) } as never,
        ctx: makeServiceContext(stub.client, {
          organizationId: 'org-test',
          role: 'admin',
          enabledModules: new Set<ModuleId>(['inventory', 'po_imports']),
        }),
      },
    };
  }

  it('sends NO variant field to create() when the module is off', async () => {
    // The line carries a full scanned variant — size, system, colour, number —
    // exactly what an AI scan of a jersey PO produces in any org.
    const stub = stubFor({ sportsCategory: false });
    const { create, deps } = nonSportsDeps(stub);

    await createItemsFromPoLines(deps, BASE_INPUT);

    const arg = create.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const k of [
      'variantSize',
      'variantSizeOriginal',
      'variantSizeSystem',
      'variantWidth',
      'variantFit',
      'variantColor',
      'jerseyNumber',
      'playerName',
    ]) {
      expect(arg, k).not.toHaveProperty(k);
    }
    // Everything else about the created row is untouched.
    expect(arg.sku).toBeTruthy();
    expect(arg.warehouseId).toBe(WAREHOUSE_ID);
  });

  it('still sends them the moment the module is on', async () => {
    const stub = stubFor({ sportsCategory: true, groupHit: true });
    const { create, deps } = depsFor(stub);

    await createItemsFromPoLines(deps, { ...BASE_INPUT, categoryId: CATEGORY_ID });

    const arg = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.variantSize).toBe('10');
    expect(arg.variantSizeSystem).toBe('US_MENS');
  });
});
