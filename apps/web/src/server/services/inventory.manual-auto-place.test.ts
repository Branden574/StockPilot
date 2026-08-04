import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Owner request 2026-08-04: "when I create an item by hand, type a rack, and
 * enter starting quantity, the stock should be placed on that rack" — no
 * more Unplaced/awaiting-put-away chip for manually created items.
 *
 * `tg_seed_initial_level` (migration 0199, an AFTER INSERT trigger on
 * inventory_items) seeds the item's first item_stock_levels holding from
 * `primary_location_id` — NOT from the 'initial' stock_movements row's
 * to_location_id. So `InventoryService.create()` resolves-or-creates the
 * typed rack and stamps ITS id onto `primary_location_id` (mirrored onto the
 * 'initial' movement's to_location_id for a truthful ledger) whenever the
 * MANUAL path creates an item with stock and a typed bin_location.
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

function buildStub(over: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'item-new' }, error: null },
    'stock_movements.insert': { data: null, error: null },
    ...over,
  });
}

function insertedItemRow(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] as Record<string, unknown>;
}

function insertedMovementRow(stub: ReturnType<typeof buildStub>) {
  return stub.chainArgs.get('stock_movements.insert')?.[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.create — manual auto-place onto a typed rack', () => {
  it('(a) existing rack matching the typed bin_location: the initial movement + primary_location_id target it', async () => {
    const stub = buildStub({
      // findOrCreateRackOrCrate's resolve step finds an existing "28-A" rack
      // in wh-1 (case-insensitive exact match) — no insert needed.
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    expect(item).toEqual({ id: 'item-new' });
    expect(insertedItemRow(stub).primary_location_id).toBe('rack-28a');
    expect(insertedMovementRow(stub).to_location_id).toBe('rack-28a');
    // No new location was minted.
    expect(stub.chainArgs.get('locations.insert')).toBeUndefined();
  });

  it('(b) no matching location: a rack is created (kind rack, type shelf, parsed number/row) and targeted', async () => {
    const stub = buildStub({
      'locations.select': { data: [], error: null },
      'locations.insert': { data: { id: 'rack-new' }, error: null },
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
    expect(insertedItemRow(stub).primary_location_id).toBe('rack-new');
    expect(insertedMovementRow(stub).to_location_id).toBe('rack-new');
  });

  it('(c) resolve+create both fail: create still succeeds, falling back to today\'s (unplaced-at-site) behavior', async () => {
    const stub = buildStub({
      'locations.select': { data: [], error: null },
      'locations.insert': { data: null, error: { message: 'plan limit exceeded' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    const item = await svc.create({ ...BASE });

    // Create still succeeds — placement is never a precondition for it.
    expect(item).toEqual({ id: 'item-new' });
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(insertedMovementRow(stub).to_location_id).toBeNull();
  });

  it('(d1) quantityOnHand = 0: no location lookup at all, even with a typed bin_location', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, quantityOnHand: 0 });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    // qty 0 also means no 'initial' stock_movements row at all.
    expect(stub.chainArgs.get('stock_movements.insert')).toBeUndefined();
  });

  it('(d2) blank/whitespace bin_location: no location lookup at all', async () => {
    const stub = buildStub();
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, binLocation: '   ' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
  });

  it('(e) import source: unchanged behavior — no location lookup, no primary_location_id stamp', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE }, { source: 'import' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
    expect(insertedMovementRow(stub).to_location_id).toBeNull();
  });

  it('CSV bulk import (opts.planSlot present, no source): unchanged behavior', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const slot = { release: vi.fn() };

    await svc.create({ ...BASE }, { planSlot: slot as unknown as never });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
  });

  it('PO-driven path (opts.awaitingFirstReceipt): unchanged behavior, keeps its own put-away step', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE }, { awaitingFirstReceipt: true });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
  });

  it('an explicit primaryLocationId from the caller wins outright — auto-place never overrides it', async () => {
    const stub = buildStub({
      'locations.select': { data: [{ id: 'rack-28a', name: '28-A' }], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.create({ ...BASE, primaryLocationId: 'site-chosen-by-caller' });

    expect(stub.fromCalls).not.toContain('locations');
    expect(insertedItemRow(stub).primary_location_id).toBe('site-chosen-by-caller');
  });

  it('a concurrent identical-rack create (23505 on the unique index) re-resolves instead of failing', async () => {
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
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    // Should not throw — falls back to unplaced (the retry's resolve step
    // uses the SAME canned empty-array select, so it also finds nothing and
    // this degrades to fail-soft rather than looping forever).
    const item = await svc.create({ ...BASE });
    expect(item).toEqual({ id: 'item-new' });
    expect(insertCalls).toBe(2); // exactly one retry, not an infinite loop
    expect(insertedItemRow(stub).primary_location_id).toBeNull();
  });
});
