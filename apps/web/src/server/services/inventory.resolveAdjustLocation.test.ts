import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * A location-less POSITIVE adjustment must never land in Staging (that bucket
 * is only for PO receipts awaiting put-away), so resolveAdjustLocation routes
 * it to the item's dominant PLACED holding, else the warehouse's Unplaced.
 *
 * Two holes in the old two-query shape:
 *  (a) the `locations` lookup had no `.is('deleted_at', null)` — although the
 *      Unplaced fallback three lines below DOES — so a rack ARCHIVED with
 *      `acknowledgeStock` (LocationsService.archive documents the surviving
 *      holdings as "simultaneously counted and unreachable") could still win.
 *      Rack 100-A, 2026-07-23: archived with 22 units still on it. A later
 *      manual +10 would land ten MORE units in a location hidden from every
 *      picker and transfer source.
 *  (b) it accepted only kind 'rack'|'crate'. `area` is equally a placement
 *      (PLACEMENT_KINDS), and a NULL kind IS the Site encoding (0292/0331 —
 *      DC4 holds 405 units that way). Both were pushed into Unplaced, which
 *      SPLITS one holding into two for no reason.
 */
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: ['wh-a'], writableIds: ['wh-a'] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { InventoryService } from './inventory';

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-test',
  warehouse_id: 'wh-a',
  status: 'active',
  quantity_on_hand: 22,
  reorder_point: 0,
  name: 'Persepolis',
  sku: 'BK-1',
};

/**
 * `locations.select` is keyed table+op, and the Unplaced fallback is the only
 * read that ends in `.maybeSingle()` — which the stub resolves from the more
 * specific `locations.select.maybeSingle` key. That separates the fallback's
 * answer from the (now removed) `.in('id', …)` kind lookup, so the two shapes
 * are distinguishable.
 */
function stubWith(holding: Record<string, unknown>, kindLookup: unknown[]) {
  return makeSupabaseStub({
    'inventory_items.select': { data: ITEM, error: null },
    'item_stock_levels.select': { data: [holding], error: null },
    'locations.select': { data: kindLookup, error: null },
    'locations.select.maybeSingle': { data: { id: 'loc-unplaced' }, error: null },
    'rpc:adjust_stock': { data: { quantity_on_hand: 32, reorder_point: 0 }, error: null },
  });
}

function destinationOf(stub: ReturnType<typeof stubWith>) {
  return (stub.rpcCalls.find((c) => c.name === 'adjust_stock')!.args as { p_location_id: string | null })
    .p_location_id;
}

beforeEach(() => vi.clearAllMocks());

describe('adjustStock — resolveAdjustLocation', () => {
  it('never routes a manual add into an ARCHIVED rack — it falls back to Unplaced', async () => {
    const stub = stubWith(
      {
        location_id: 'loc-100a',
        quantity: 22,
        locations: { id: 'loc-100a', kind: 'rack', deleted_at: '2026-08-19T00:00:00Z' },
      },
      [{ id: 'loc-100a', kind: 'rack' }],
    );
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.adjustStock({ itemId: 'itm-1', quantityChange: 10, movementType: 'add' });

    expect(destinationOf(stub)).toBe('loc-unplaced');
  });

  it('keeps a SITE (NULL-kind) holding rather than splitting it into Unplaced', async () => {
    const stub = stubWith(
      {
        location_id: 'loc-site',
        quantity: 405,
        locations: { id: 'loc-site', kind: null, deleted_at: null },
      },
      [{ id: 'loc-site', kind: null }],
    );
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.adjustStock({ itemId: 'itm-1', quantityChange: 10, movementType: 'add' });

    expect(destinationOf(stub)).toBe('loc-site');
  });

  it('an AREA holding is a placement too (PLACEMENT_KINDS), not Unplaced', async () => {
    const stub = stubWith(
      {
        location_id: 'loc-area',
        quantity: 12,
        locations: { id: 'loc-area', kind: 'area', deleted_at: null },
      },
      [{ id: 'loc-area', kind: 'area' }],
    );
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.adjustStock({ itemId: 'itm-1', quantityChange: 10, movementType: 'add' });

    expect(destinationOf(stub)).toBe('loc-area');
  });

  it('a LIVE rack still wins (unchanged behaviour)', async () => {
    const stub = stubWith(
      {
        location_id: 'loc-rack',
        quantity: 7,
        locations: { id: 'loc-rack', kind: 'rack', deleted_at: null },
      },
      [{ id: 'loc-rack', kind: 'rack' }],
    );
    const svc = new InventoryService(makeServiceContext(stub.client));

    await svc.adjustStock({ itemId: 'itm-1', quantityChange: 10, movementType: 'add' });

    expect(destinationOf(stub)).toBe('loc-rack');
  });
});
