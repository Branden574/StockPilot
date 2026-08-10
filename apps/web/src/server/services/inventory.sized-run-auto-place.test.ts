import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

/**
 * Owner report 2026-08-10: creating a SIZE RUN (a shoe run — one row per size)
 * with a rack typed in left every variant reading "Unplaced / awaiting
 * put-away". `bulkCreateSizedVariants` wrote `bin_location` (the text LABEL)
 * onto each row and stopped there: `tg_seed_initial_level` (migration 0199)
 * seeded each variant's holding at `primary_location_id` (a SITE) or the
 * warehouse's Unplaced bucket, and nothing ever moved it onto the rack.
 *
 * A GAP, not a regression — the 2026-08-04 auto-place work (PR #69) covered
 * manual SINGLE create and bulk "Set rack" and never covered the size run,
 * which is also why this file exists: the size-run suites had zero
 * rack/placement coverage, so nothing failed when the feature shipped
 * incomplete.
 *
 * These tests are the twin of inventory.manual-auto-place.test.ts (the single
 * create path) and use its harness deliberately: same stub, same
 * "the trigger already seeded a holding" modelling, same landmine guard.
 *
 * THE LANDMINE, restated because it has a review history: the fix must never
 * write a rack id into `primary_location_id`. That column is read as a SITE
 * everywhere else — the location filter (instant-mode.ts) tests it against a
 * sites-only set and exports resolve it into a "Primary location" column — so
 * stamping a rack there makes auto-placed rows vanish from location-filtered
 * views and duplicates the rack label into exports. `primary_location_id` and
 * the 'initial' movement's `to_location_id` must come out of this fix
 * byte-unchanged; the stock moves via transfer_stock instead.
 */
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

/** The caller's own primary location — a SITE, which is the only thing that
 *  column is ever allowed to hold. Every test asserts it survives untouched. */
const SITE = 'site-dc4';

const RUN = {
  baseName: 'Nike Vapor',
  baseSku: 'SP-VAPOR',
  baseBarcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: SITE,
  // What the Add Item form composes from the rack number/row boxes
  // (formatRackLabel) for a size run — the SAME field, composed the same way,
  // that the single-item path sends as its typed rack.
  binLocation: '28-A',
  retailPrice: 0,
  unitCost: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitOfMeasure: 'unit',
  variants: [
    { size: '9', quantity: 3 },
    { size: '9.5', quantity: 5 },
    { size: '10', quantity: 7 },
  ],
};

/** The rows the insert hands back — ids/quantities the service then places.
 *  `primary_location_id` echoes the caller's SITE, exactly as the DB would. */
const INSERTED = [
  { id: 'v-9', name: 'Nike Vapor - 9', sku: 'SP-VAPOR-9', quantity_on_hand: 3, primary_location_id: SITE },
  { id: 'v-95', name: 'Nike Vapor - 9.5', sku: 'SP-VAPOR-9.5', quantity_on_hand: 5, primary_location_id: SITE },
  { id: 'v-10', name: 'Nike Vapor - 10', sku: 'SP-VAPOR-10', quantity_on_hand: 7, primary_location_id: SITE },
];

const categoryRow = {
  id: 'cat-1',
  parent_id: null,
  tracking_mode: null,
  size_scale_id: null,
  default_unit_of_measure: null,
  sports_subcategory_key: null,
  tracking_profile: null,
  deleted_at: null,
};

/**
 * Per-variant seeded holdings, standing in for what the 0199 trigger wrote.
 * Keyed by item id and DISTINCT per variant (its own from-location and its own
 * quantity) so a transfer can never be silently attributed to the wrong
 * variant: (p_item_id, p_from_location_id, p_quantity) only lines up one way.
 *
 * No entry for a zero-quantity variant — 0199 returns early on qty <= 0, so
 * such a row genuinely has no holding to move.
 */
const SEEDED: Record<string, { location_id: string; quantity: number }> = {
  'v-9': { location_id: 'seed-v-9', quantity: 3 },
  'v-95': { location_id: 'seed-v-95', quantity: 5 },
  'v-10': { location_id: 'seed-v-10', quantity: 7 },
};

let stubRef: SupabaseStub | null = null;

/** The `.in('item_id', [...])` list the in-flight holdings read asked for. */
function holdingsReadScope(): string[] | null {
  const chains = stubRef?.chainArgsAll.get('item_stock_levels.select') ?? [];
  const inFlight = chains[chains.length - 1] ?? [];
  const inArg = inFlight.find((a) => a[0] === 'item_id' && Array.isArray(a[1]));
  return inArg ? ([...(inArg[1] as string[])] as string[]) : null;
}

/**
 * Answers the holdings read with one row per REQUESTED id that actually has a
 * seeded holding — i.e. the stub mirrors the query's own scope instead of
 * canning a fixed answer, which is what lets a test assert "the read asked
 * about exactly these variants".
 */
function seededHoldings(): QueryResult {
  const ids = holdingsReadScope() ?? [];
  return {
    data: ids
      .filter((id) => SEEDED[id])
      .map((id) => ({ item_id: id, location_id: SEEDED[id]!.location_id, quantity: SEEDED[id]!.quantity })),
    error: null,
  };
}

function buildStub(over: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    // Plan-limit head count + the org's plan (enterprise = unlimited).
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'categories.select': { data: categoryRow, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    // The fan-out insert returns every created row back to the service.
    'inventory_items.insert': { data: INSERTED, error: null },
    'stock_movements.insert': { data: null, error: null },
    // findOrCreateRackOrCrate's resolve step finds an existing "28-A" rack in
    // wh-1, so no location is minted.
    'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    'item_stock_levels.select': seededHoldings,
    'rpc:transfer_stock': { data: null, error: null },
    ...over,
  });
  stubRef = stub;
  return stub;
}

function insertedRows(stub: SupabaseStub) {
  return (stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] ?? []) as Array<
    Record<string, unknown>
  >;
}

function insertedMovements(stub: SupabaseStub) {
  return (stub.chainArgs.get('stock_movements.insert')?.[0]?.[0] ?? []) as Array<
    Record<string, unknown>
  >;
}

function transfers(stub: SupabaseStub) {
  return stub.rpcCalls
    .filter((c) => c.name === 'transfer_stock')
    .map((c) => c.args as Record<string, unknown>);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stubRef = null;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe('InventoryService.bulkCreateSizedVariants — size-run auto-place onto a typed rack', () => {
  it('places EVERY stocked variant of the run onto the resolved rack, each from its own seeded holding', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    const created = await svc.bulkCreateSizedVariants({ ...RUN });

    expect(created.map((r) => r.id)).toEqual(['v-9', 'v-95', 'v-10']);
    // One transfer per variant, each moving THAT variant's own holding onto the
    // one resolved rack. Asserted per variant, not "transferStock was called".
    expect(transfers(stub)).toEqual([
      {
        p_item_id: 'v-9',
        p_from_location_id: 'seed-v-9',
        p_to_location_id: 'rack-28a',
        p_quantity: 3,
        p_notes: 'Placed on rack 28-A at creation',
      },
      {
        p_item_id: 'v-95',
        p_from_location_id: 'seed-v-95',
        p_to_location_id: 'rack-28a',
        p_quantity: 5,
        p_notes: 'Placed on rack 28-A at creation',
      },
      {
        p_item_id: 'v-10',
        p_from_location_id: 'seed-v-10',
        p_to_location_id: 'rack-28a',
        p_quantity: 7,
        p_notes: 'Placed on rack 28-A at creation',
      },
    ]);
    // No rack was minted — the existing 28-A was reused (shared resolve path).
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    // ONE batched holdings read for the whole run, not one per variant.
    expect(stub.chainsAll.get('item_stock_levels.select')?.length).toBe(1);
    expect(holdingsReadScope()).toEqual(['v-9', 'v-95', 'v-10']);
  });

  it('LANDMINE: primary_location_id stays the SITE the caller passed on every variant — never the rack id', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({ ...RUN });

    const rows = insertedRows(stub);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.primary_location_id).toBe(SITE);
      expect(row.primary_location_id).not.toBe('rack-28a');
      // The typed rack still lands where it always did: the text LABEL column.
      expect(row.bin_location).toBe('28-A');
    }
    // The ledger's opening entries point at the SITE too — byte-unchanged.
    const movements = insertedMovements(stub);
    expect(movements).toHaveLength(3);
    for (const m of movements) {
      expect(m.movement_type).toBe('initial');
      expect(m.to_location_id).toBe(SITE);
    }
    // And nothing re-stamps the column afterwards: placement performs NO
    // inventory_items write at all, so a later "just set primary_location_id to
    // the rack" can never sneak back in.
    expect(stub.chainArgs.get('inventory_items.update')).toBeUndefined();
    // The physical move is the only thing that happened, and it went to the rack.
    expect(transfers(stub).map((t) => t.p_to_location_id)).toEqual([
      'rack-28a',
      'rack-28a',
      'rack-28a',
    ]);
  });

  it('the ledger reads like a human put-away: an opening initial per variant, then its transfer', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({ ...RUN });

    // 'initial' rows are written by the service BEFORE any placement (the
    // transfer rows are written by transfer_stock itself), so the ledger reads
    // initial → transfer per variant, exactly as the single create path does.
    expect(insertedMovements(stub).map((m) => [m.item_id, m.quantity_change])).toEqual([
      ['v-9', 3],
      ['v-95', 5],
      ['v-10', 7],
    ]);
    expect(transfers(stub)).toHaveLength(3);
  });

  it('NO rack typed: behaves exactly as it did before this fix — no rack lookup, no holdings read, no transfer', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({ ...RUN, binLocation: null });

    expect(stub.fromCalls).not.toContain('locations');
    expect(stub.chainArgs.get('item_stock_levels.select')).toBeUndefined();
    expect(transfers(stub)).toHaveLength(0);
    // Still a normal create: rows and their opening ledger are untouched.
    expect(insertedRows(stub)).toHaveLength(3);
    expect(insertedMovements(stub)).toHaveLength(3);
  });

  it('a whitespace-only rack label is not a typed rack either', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({ ...RUN, binLocation: '   ' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(transfers(stub)).toHaveLength(0);
  });

  it('a variant left at quantity 0 is never placed — it is not even in the holdings read', async () => {
    const stub = buildStub({
      'inventory_items.insert': {
        data: [
          INSERTED[0],
          { id: 'v-0', name: 'Nike Vapor - 11', sku: 'SP-VAPOR-11', quantity_on_hand: 0, primary_location_id: SITE },
          INSERTED[2],
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({
      ...RUN,
      variants: [
        { size: '9', quantity: 3 },
        { size: '11', quantity: 0 },
        { size: '10', quantity: 7 },
      ],
    });

    // The read is scoped to the STOCKED variants only. This is the assertion
    // that notices if the quantity gate is dropped: a zero-quantity row has no
    // holding for the DB to return, so the only visible symptom of asking about
    // it is the widened scope.
    expect(holdingsReadScope()).toEqual(['v-9', 'v-10']);
    // And it is placed nowhere.
    expect(transfers(stub).map((t) => t.p_item_id)).toEqual(['v-9', 'v-10']);
    // Consistent with the rest of the path: no opening movement for it either.
    expect(insertedMovements(stub).map((m) => m.item_id)).toEqual(['v-9', 'v-10']);
  });

  it('a run where NO size carries stock places nothing at all', async () => {
    const stub = buildStub({
      'inventory_items.insert': {
        data: [
          { id: 'v-9', name: 'n', sku: 's1', quantity_on_hand: 0, primary_location_id: SITE },
          { id: 'v-10', name: 'n', sku: 's2', quantity_on_hand: 0, primary_location_id: SITE },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({
      ...RUN,
      variants: [
        { size: '9', quantity: 0 },
        { size: '10', quantity: 0 },
      ],
    });

    expect(stub.fromCalls).not.toContain('locations');
    expect(transfers(stub)).toHaveLength(0);
  });

  it('ONE variant failing to place does not fail the create and does not cost the others their placement', async () => {
    const stub = buildStub({
      'rpc:transfer_stock': () => {
        const last = stubRef?.rpcCalls[stubRef.rpcCalls.length - 1];
        const args = (last?.args ?? {}) as { p_item_id?: string };
        return args.p_item_id === 'v-95'
          ? { data: null, error: { message: 'insufficient_stock' } }
          : { data: null, error: null };
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // Must NOT throw: the variants and their ledger committed before placement.
    const created = await svc.bulkCreateSizedVariants({ ...RUN });
    expect(created.map((r) => r.id)).toEqual(['v-9', 'v-95', 'v-10']);

    // All three were attempted, and the two healthy ones still went to the rack.
    expect(transfers(stub).map((t) => [t.p_item_id, t.p_to_location_id])).toEqual([
      ['v-9', 'rack-28a'],
      ['v-95', 'rack-28a'],
      ['v-10', 'rack-28a'],
    ]);

    // The failure was CONTAINED AT THE VARIANT and attributed to it. If the
    // throw were allowed to escape the per-variant boundary instead, the whole
    // batch would unwind into the call site's catch-all and this per-item log
    // would never be written — which is the difference this asserts.
    const perVariant = errorSpy.mock.calls.filter(
      (c) => String(c[0]) === '[rack place] create-time transfer failed',
    );
    expect(perVariant).toHaveLength(1);
    expect(perVariant[0]?.[1]).toMatchObject({ item: 'v-95', rack: '28-A' });
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]) === '[sized variants] auto-place failed'),
    ).toBe(false);
  });

  it('a failure in the FIRST concurrency wave still leaves later waves placed', async () => {
    // 25 variants > the placement concurrency cap (20), so the run spans two
    // waves and variant #1's failure lands in the first. A throw that escaped
    // the per-variant boundary would reject that wave's Promise.all and abandon
    // the loop, so waves 2+ would never be attempted at all. (If the cap is
    // ever raised above 25 this degrades to the log-site assertion below, which
    // is also checked here.)
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `m-${i}`,
      name: `n-${i}`,
      sku: `s-${i}`,
      quantity_on_hand: 2,
      primary_location_id: SITE,
    }));
    for (const row of many) SEEDED[row.id] = { location_id: `seed-${row.id}`, quantity: 2 };
    const stub = buildStub({
      'inventory_items.insert': { data: many, error: null },
      'rpc:transfer_stock': () => {
        const last = stubRef?.rpcCalls[stubRef.rpcCalls.length - 1];
        const args = (last?.args ?? {}) as { p_item_id?: string };
        return args.p_item_id === 'm-0'
          ? { data: null, error: { message: 'insufficient_stock' } }
          : { data: null, error: null };
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({
      ...RUN,
      variants: many.map((_, i) => ({ size: String(20 + i), quantity: 2 })),
    });

    const placed = transfers(stub).map((t) => t.p_item_id);
    expect(placed).toHaveLength(25);
    // The tail of the run — the second wave — was placed despite the very first
    // variant failing.
    expect(placed).toContain('m-24');
    expect(
      errorSpy.mock.calls.filter(
        (c) => String(c[0]) === '[rack place] create-time transfer failed',
      ),
    ).toHaveLength(1);

    for (const row of many) delete SEEDED[row.id];
  });

  it('the rack never resolving leaves the run created and unplaced, with no transfer attempted', async () => {
    const stub = buildStub({
      'locations.select': { data: [], error: null },
      'locations.insert': { data: null, error: { message: 'plan limit exceeded' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const created = await svc.bulkCreateSizedVariants({ ...RUN });

    // The create is never a casualty of placement.
    expect(created).toHaveLength(3);
    expect(insertedRows(stub).every((r) => r.primary_location_id === SITE)).toBe(true);
    // Returns before the holdings read when there is nowhere to put anything.
    expect(stub.chainArgs.get('item_stock_levels.select')).toBeUndefined();
    expect(transfers(stub)).toHaveLength(0);
  });

  it('a variant whose seeded holding is ALREADY on the resolved rack is left alone (idempotent)', async () => {
    const stub = buildStub({
      'inventory_items.insert': { data: [INSERTED[0], INSERTED[1]], error: null },
    });
    SEEDED['v-9'] = { location_id: 'rack-28a', quantity: 3 };
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.bulkCreateSizedVariants({
      ...RUN,
      variants: [
        { size: '9', quantity: 3 },
        { size: '9.5', quantity: 5 },
      ],
    });

    SEEDED['v-9'] = { location_id: 'seed-v-9', quantity: 3 };
    // Only the variant that needed moving was moved — no same-location
    // transfer (transfer_stock raises 'same_location' on one).
    expect(transfers(stub).map((t) => t.p_item_id)).toEqual(['v-95']);
  });
});
