import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Owner request 2026-08-04: "when I create an item by hand, type a rack, and
 * enter starting quantity, the stock should be placed on that rack" — no
 * more Unplaced/awaiting-put-away chip for manually created items.
 *
 * REDESIGNED per review (Minor #3): `create()` does NOT touch
 * `primary_location_id` or the 'initial' movement's `to_location_id` — both
 * pass through exactly as the caller sent them, because `primary_location_id`
 * is read far beyond the seeding trigger (the location filter, exports,
 * pickers all assume a SITE). `tg_seed_initial_level` (migration 0199) seeds
 * the item's first item_stock_levels holding exactly as it does today; THEN
 * `InventoryService.create()` reuses the bulk "Set rack" placement path —
 * resolve-or-create the typed rack (findOrCreateRackLocation, shared with
 * placeItemsOntoRackByName) and transferStock the seeded holding onto it.
 *
 * PO/receiving paths (`opts.awaitingFirstReceipt`), the PO-import approve
 * path (`opts.source === 'import'`), and the CSV bulk importer
 * (`opts.planSlot`) are excluded — see the guard comment in create().
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

const BASE = {
  name: 'Test item',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 5,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
  binLocation: '28-A',
};

// `tg_seed_initial_level` (0199) is a real Postgres trigger — this JS mock
// never executes it, so tests that need a seeded holding for
// placeManualCreateOnRack to move stub `item_stock_levels.select` directly,
// standing in for "the trigger already ran and put 5 units at wh-1's
// Unplaced bucket" (or wherever the item's own primary_location_id pointed).
const SEEDED_AT_UNPLACED = {
  'item_stock_levels.select': {
    data: [{ location_id: 'unplaced-wh1', quantity: 5 }],
    error: null,
  },
};

function buildStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'item-new' }, error: null },
    'stock_movements.insert': { data: null, error: null },
    'rpc:transfer_stock': { data: null, error: null },
    ...over,
  });
}

function insertedItemRow(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] as Record<string, unknown>;
}

function insertedMovementRow(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('stock_movements.insert')?.[0]?.[0] as Record<string, unknown>;
}

function transferCall(stub: ReturnType<typeof buildStub>) {
  return stub.rpcCalls.find((c) => c.name === 'transfer_stock');
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.create — manual auto-place onto a typed rack', () => {
  it('(a) existing rack matching the typed bin_location: the seeded holding transfers onto it; primary_location_id/to_location_id are UNTOUCHED', async () => {
    const stub = buildStub({
      // findOrCreateRackOrCrate's resolve step finds an existing "28-A" rack
      // in wh-1 (case-insensitive exact match) — no insert needed.
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    expect(item).toEqual({ id: 'item-new' });
    // The item row and its ledger entry are BYTE-IDENTICAL to pre-feature
    // behavior — no primaryLocationId was supplied, so both stay null.
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(insertedMovementRow(stub).to_location_id).toBeNull();
    // No new location was minted.
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
    // The seeded holding physically moved onto the rack via transferStock.
    const transfer = transferCall(stub);
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-new',
      p_from_location_id: 'unplaced-wh1',
      p_to_location_id: 'rack-28a',
      p_quantity: 5,
    });
  });

  it('(b) no matching location: a rack is created (kind rack, type shelf, parsed number/row) and the seeded holding transfers there', async () => {
    const stub = buildStub({
      'locations.select': { data: [], error: null },
      'locations.insert': { data: { id: 'rack-new' }, error: null },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    expect(item).toEqual({ id: 'item-new' });
    const createdLoc = stub.chainArgs.get('locations.insert')?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(createdLoc).toMatchObject({
      name: '28-A',
      kind: 'rack',
      type: 'shelf',
      warehouse_id: 'wh-1',
      rack_number: '28',
      rack_row: 'A',
    });
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    const transfer = transferCall(stub);
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_item_id: 'item-new',
      p_from_location_id: 'unplaced-wh1',
      p_to_location_id: 'rack-new',
      p_quantity: 5,
    });
  });

  it("(c) rack resolve+create both fail: create still succeeds, no holdings read and no transfer attempted — falls back to today's (unplaced-at-site) behavior", async () => {
    const stub = buildStub({
      'locations.select': { data: [], error: null },
      'locations.insert': { data: null, error: { message: 'plan limit exceeded' } },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    // Create still succeeds — placement is never a precondition for it.
    expect(item).toEqual({ id: 'item-new' });
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(insertedMovementRow(stub).to_location_id).toBeNull();
    // placeManualCreateOnRack returns BEFORE reading holdings when the rack
    // never resolved — no wasted read, no transfer.
    expect(stub.chainArgs.get('item_stock_levels.select')).toBeUndefined();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('fail-soft when the transfer itself throws (rack resolves, holding is found, but transferStock errors): create still succeeds', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      ...SEEDED_AT_UNPLACED,
      'rpc:transfer_stock': { data: null, error: { message: 'insufficient_stock' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // Must NOT throw — the item was already created successfully before
    // placement ran.
    const item = await svc.create({ ...BASE });

    expect(item).toEqual({ id: 'item-new' });
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    // The attempt was made (proving we didn't just skip it)...
    expect(transferCall(stub)).toBeDefined();
    // ...but its failure never escaped create().
  });

  it('(d1) quantityOnHand = 0: no location lookup at all, even with a typed bin_location', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, quantityOnHand: 0 });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    // qty 0 also means no 'initial' stock_movements row at all.
    expect(stub.chainArgs.get('stock_movements.insert')).toBeUndefined();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('(d2) blank/whitespace bin_location: no location lookup at all', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, binLocation: '   ' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('(e) import source: unchanged behavior — no location lookup, no transfer', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE }, { source: 'import' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(insertedMovementRow(stub).to_location_id).toBeNull();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('CSV bulk import (opts.planSlot present, no source): unchanged behavior', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const slot = { release: vi.fn() };

    await svc.create({ ...BASE }, { planSlot: slot as unknown as never });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('PO-driven path (opts.awaitingFirstReceipt): unchanged behavior, keeps its own put-away step', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE }, { awaitingFirstReceipt: true });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(transferCall(stub)).toBeUndefined();
  });

  it('an explicit primaryLocationId from the caller passes through UNCHANGED — auto-place still runs, transferring FROM the site the trigger seeded', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
      // Models the trigger seeding at the caller's OWN primaryLocationId
      // (a real site) rather than the warehouse's Unplaced bucket.
      'item_stock_levels.select': {
        data: [{ location_id: 'site-chosen-by-caller', quantity: 5 }],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, primaryLocationId: 'site-chosen-by-caller' });

    // create() never rewrites the caller's explicit choice.
    expect(insertedItemRow(stub).primary_location_id).toBe('site-chosen-by-caller');
    expect(insertedMovementRow(stub).to_location_id).toBe('site-chosen-by-caller');
    // Auto-place is NOT gated on primaryLocationId being unset anymore —
    // it still moves whatever the trigger seeded onto the typed rack.
    const transfer = transferCall(stub);
    expect(transfer).toBeDefined();
    expect(transfer!.args).toMatchObject({
      p_from_location_id: 'site-chosen-by-caller',
      p_to_location_id: 'rack-28a',
      p_quantity: 5,
    });
  });

  it('a concurrent identical-rack create (23505 on the unique index) re-resolves instead of failing; still no transfer once resolution truly fails', async () => {
    let insertCalls = 0;
    const stub = buildStub({
      // First resolve finds nothing; the insert then races and loses.
      'locations.select': { data: [], error: null },
      'locations.insert': () => {
        insertCalls += 1;
        return {
          data: null,
          error: {
            message:
              'duplicate key value violates unique constraint "locations_unique_active_name"',
            code: '23505',
          },
        };
      },
      ...SEEDED_AT_UNPLACED,
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // Should not throw — falls back to unplaced (the retry's resolve step
    // uses the SAME canned empty-array select, so it also finds nothing and
    // this degrades to fail-soft rather than looping forever).
    const item = await svc.create({ ...BASE });
    expect(item).toEqual({ id: 'item-new' });
    expect(insertCalls).toBe(2); // exactly one retry, not an infinite loop
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(transferCall(stub)).toBeUndefined();
  });
});
