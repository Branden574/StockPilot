import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// unstable_cache/revalidateTag: the actions under test import the
// inventory-list loader (cache invalidation helper), whose module graph
// builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

// Same hoisted-mock pattern as inventory.placeStock.test.ts: bulkPlaceStockAction
// resolves withContext() once, then uses ctx.supabase for the destination
// org-verification and new InventoryService/LocationsService for the writes —
// transferStock + stampPlacementBin (post-move label re-stamp, once per batch)
// on InventoryService, findOrCreatePlacementDestination (dedup-safe rack lookup, Unit A)
// on LocationsService.
const {
  mockTransferStock,
  mockStampPlacementBin,
  mockAssertBookCrate,
  mockSyncBookCrate,
  mockFindOrCreateRackOrCrate,
  mockFindRackOrCrate,
  ctxRef,
} = vi.hoisted(() => ({
  mockTransferStock: vi.fn(async () => undefined),
  mockStampPlacementBin: vi.fn(async () => undefined),
  // The book-crate confirmation gate + post-move summary reconciliation. Both
  // default to "nothing to do" so the pre-existing rack cases below are
  // unaffected; the dedicated crate suite drives their real behaviour.
  mockAssertBookCrate: vi.fn(async () => new Map()),
  mockSyncBookCrate: vi.fn(async () => ({
    syncedItemIds: [] as string[],
    failedItemIds: [] as string[],
    skippedItemIds: [] as string[],
    staleItemIds: [] as string[],
    unplacedItemIds: [] as string[],
    rackPreservedItemIds: [] as string[],
    cratePreservedItemIds: [] as string[],
  })),
  // Returns a `locations` ROW (the real method does select('*')), so tests can
  // hand back the crate/rack columns the placement label is derived from.
  mockFindOrCreateRackOrCrate: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ id: 'new-loc-99' }),
  ),
  mockFindRackOrCrate: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  ctxRef: { ctx: null as unknown },
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: vi.fn(async () => ctxRef.ctx) };
});

vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    transferStock = mockTransferStock;
    stampPlacementBin = mockStampPlacementBin;
    assertBookCratePlacementAllowed = mockAssertBookCrate;
    syncBookCratePlacement = mockSyncBookCrate;
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: class {
    findOrCreatePlacementDestination = mockFindOrCreateRackOrCrate;
    // The READ half, now that the gate runs BEFORE the row is minted. Defaults
    // to "nothing to reuse", so these suites still exercise the create path and
    // `findOrCreatePlacementDestination` is still what actually mints.
    findRackOrCrate = mockFindRackOrCrate;
  },
}));

import { ServiceError } from '@/server/services/context';
import { bulkPlaceStockAction } from './inventory';

const ITEM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FROM_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FROM_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const EXISTING_LOC = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const WAREHOUSE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const ORG_ID = 'org-test';

function installContext(opts: {
  locationRow?: Record<string, unknown> | null;
  warehouseRow?: Record<string, unknown> | null;
} = {}): SupabaseStub {
  const locationRow =
    'locationRow' in opts
      ? opts.locationRow
      : { id: EXISTING_LOC, warehouse_id: WAREHOUSE_ID, kind: 'rack' };
  const warehouseRow = 'warehouseRow' in opts ? opts.warehouseRow : { id: WAREHOUSE_ID };
  const stub = makeSupabaseStub({
    'locations.select': { data: locationRow ?? null, error: null },
    'warehouses.select': { data: warehouseRow ?? null, error: null },
  });
  ctxRef.ctx = {
    organizationId: ORG_ID,
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
    supabase: stub.client,
  };
  return stub;
}

const TWO = [
  { itemId: ITEM_A, fromLocationId: FROM_A, quantity: 500 },
  { itemId: ITEM_B, fromLocationId: FROM_B, quantity: 150 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockTransferStock.mockResolvedValue(undefined);
  mockStampPlacementBin.mockResolvedValue(undefined);
  mockAssertBookCrate.mockResolvedValue(new Map());
  mockSyncBookCrate.mockResolvedValue({
    syncedItemIds: [],
    failedItemIds: [],
    skippedItemIds: [],
    staleItemIds: [],
    unplacedItemIds: [],
    rackPreservedItemIds: [],
    cratePreservedItemIds: [],
  });
  mockFindOrCreateRackOrCrate.mockResolvedValue({ id: 'new-loc-99' });
  installContext();
});

describe('bulkPlaceStockAction', () => {
  it('1. places every item into ONE existing rack (full qty each), no location created', async () => {
    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
    expect(mockTransferStock).toHaveBeenCalledTimes(2);
    expect(mockTransferStock).toHaveBeenNthCalledWith(1, {
      itemId: ITEM_A,
      fromLocationId: FROM_A,
      toLocationId: EXISTING_LOC,
      quantity: 500,
      notes: undefined,
    });
    expect(mockTransferStock).toHaveBeenNthCalledWith(2, {
      itemId: ITEM_B,
      fromLocationId: FROM_B,
      toLocationId: EXISTING_LOC,
      quantity: 150,
      notes: undefined,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.placed).toBe(2);
      expect(res.data.failed).toEqual([]);
    }

    // One label-stamp for the whole batch, covering both placed items.
    expect(mockStampPlacementBin).toHaveBeenCalledOnce();
    expect(mockStampPlacementBin).toHaveBeenCalledWith([ITEM_A, ITEM_B], {
      kind: 'rack',
      rackNumber: null,
      rackRow: null,
      name: null,
      crateColor: null,
      crateNumber: null,
    });
  });

  it('2. creates the new rack ONCE (via findOrCreatePlacementDestination — Unit A), then places all items into it', async () => {
    const newLocId = '99999999-9999-9999-9999-999999999999';
    // A full `locations` ROW — what the real findOrCreatePlacementDestination returns
    // (select('*')) and what the label stamp is now derived from.
    mockFindOrCreateRackOrCrate.mockResolvedValue({
      id: newLocId,
      kind: 'rack',
      name: 'BULK-1',
      rack_number: 'BULK-1',
      rack_row: null,
      crate_color: null,
      crate_number: null,
    });

    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'BULK-1' } },
    });

    expect(mockFindOrCreateRackOrCrate).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledTimes(2);
    expect(mockTransferStock).toHaveBeenNthCalledWith(1, expect.objectContaining({ toLocationId: newLocId, itemId: ITEM_A }));
    expect(mockTransferStock).toHaveBeenNthCalledWith(2, expect.objectContaining({ toLocationId: newLocId, itemId: ITEM_B }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.placed).toBe(2);

    // Label stamp reflects the RESOLVED location row's own fields, not the
    // typed input (findOrCreatePlacementDestination may hand back a pre-existing rack).
    expect(mockStampPlacementBin).toHaveBeenCalledWith([ITEM_A, ITEM_B], {
      kind: 'rack',
      rackNumber: 'BULK-1',
      rackRow: null,
      name: 'BULK-1',
      crateColor: null,
      crateNumber: null,
    });
  });

  it('3. rejects a cross-tenant existing destination — NO transfers', async () => {
    installContext({ locationRow: null });
    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: EXISTING_LOC },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/not found in your organization/i);
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('4. rejects placing INTO a staging/unplaced bucket — NO transfers', async () => {
    installContext({ locationRow: { id: EXISTING_LOC, warehouse_id: WAREHOUSE_ID, kind: 'unplaced' } });
    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: EXISTING_LOC },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/rack or crate/i);
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('5. records a per-item failure (insufficient_stock) and still places the rest', async () => {
    mockTransferStock
      .mockResolvedValueOnce(undefined) // ITEM_A places
      .mockRejectedValueOnce(
        new ServiceError('internal_error', 'insufficient_stock: cannot move 150 of 0'),
      ); // ITEM_B fails

    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(mockTransferStock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.placed).toBe(1);
      expect(res.data.failed).toEqual([
        { itemId: ITEM_B, message: 'Not enough available to place.' },
      ]);
    }

    // Only the item that actually landed gets its label re-stamped.
    expect(mockStampPlacementBin).toHaveBeenCalledWith([ITEM_A], {
      kind: 'rack',
      rackNumber: null,
      rackRow: null,
      name: null,
      crateColor: null,
      crateNumber: null,
    });
  });

  it('6. rejects an empty placement list before touching context', async () => {
    const res = await bulkPlaceStockAction({
      placements: [],
      destination: { existingLocationId: EXISTING_LOC },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(mockTransferStock).not.toHaveBeenCalled();
  });
});
