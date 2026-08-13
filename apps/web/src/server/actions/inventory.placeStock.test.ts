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

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that trigger the mocked
// modules (vi.hoisted runs before module evaluation).
//
// placeStockAction resolves `withContext()` once, then constructs
// `new InventoryService(ctx)` / `new LocationsService(ctx)` and uses
// `ctx.supabase` directly for the org-verification lookups. So we mock:
//  - withContext() → returns a ServiceContext-shaped object whose supabase is
//    a configurable stub (controls the locations/warehouses verification rows).
//  - the InventoryService / LocationsService classes → spy constructors whose
//    instances expose transferStock / stampPlacementBin / findOrCreateRackOrCrate
//    spies — the SAME methods the action actually calls (dedup-safe rack
//    lookup + the post-transfer bin_location label stamp).
// ---------------------------------------------------------------------------

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
  })),
  mockFindOrCreateRackOrCrate: vi.fn(async () => ({ id: 'new-loc-99' })),
  mockFindRackOrCrate: vi.fn(async () => null as { id: string } | null),
  ctxRef: { ctx: null as unknown },
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ctxRef.ctx),
  };
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
    findOrCreateRackOrCrate = mockFindOrCreateRackOrCrate;
    // The READ half, now that the gate runs BEFORE the row is minted. Defaults
    // to "nothing to reuse", so these suites still exercise the create path and
    // `findOrCreateRackOrCrate` is still what actually mints.
    findRackOrCrate = mockFindRackOrCrate;
  },
}));

import { ServiceError } from '@/server/services/context';
import { placeStockAction } from './inventory';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FROM_LOC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXISTING_LOC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WAREHOUSE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ORG_ID = 'org-test';

/**
 * Install a fresh org context whose supabase stub answers the destination
 * verification lookups. `locationRow`/`warehouseRow` default to a valid
 * same-org row; pass `null` to simulate a cross-tenant / missing row.
 */
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
  });
  mockFindOrCreateRackOrCrate.mockResolvedValue({ id: 'new-loc-99' });
  installContext();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('placeStockAction', () => {
  it('1. places to an existing (same-org) location via transfer_stock', async () => {
    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      notes: 'test note',
      destination: { existingLocationId: EXISTING_LOC },
    });

    // No location was created
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();

    // transfer_stock was called with the existing location id and correct quantity
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: EXISTING_LOC,
      quantity: 5,
      notes: 'test note',
    });

    // Action returns ok with the toLocationId
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(EXISTING_LOC);

    // The placement label is re-stamped after the physical move, using the
    // destination's kind/rack fields (none of which the stub location row
    // sets here, so it's a bare rack with no number/row/name).
    expect(mockStampPlacementBin).toHaveBeenCalledWith([ITEM_ID], {
      kind: 'rack',
      rackNumber: null,
      rackRow: null,
      name: null,
      crateColor: null,
      crateNumber: null,
    });
  });

  it('2. creates a rack (via the dedup-safe findOrCreateRackOrCrate lookup) then transfers to the new location id', async () => {
    const newLocId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    const callOrder: string[] = [];
    // Returns a full `locations` ROW, because that is what the real
    // findOrCreateRackOrCrate returns (select('*')) and what the action now
    // derives the placement label from.
    mockFindOrCreateRackOrCrate.mockImplementation(async () => {
      callOrder.push('create');
      return {
        id: newLocId,
        kind: 'rack',
        name: 'R-42-B',
        rack_number: 'R-42',
        rack_row: 'B',
        crate_color: null,
        crate_number: null,
      };
    });
    mockTransferStock.mockImplementation(async () => {
      callOrder.push('transfer');
    });

    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: {
        newRack: {
          warehouseId: WAREHOUSE_ID,
          rackNumber: 'R-42',
          rackRow: 'B',
        },
      },
    });

    // findOrCreateRackOrCrate (the dedup-safe lookup — Unit A) was called
    // with kind='rack' (no crateColor)
    expect(mockFindOrCreateRackOrCrate).toHaveBeenCalledOnce();
    const createArg = (mockFindOrCreateRackOrCrate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.kind).toBe('rack');
    expect(createArg.type).toBe('shelf');
    expect(createArg.warehouseId).toBe(WAREHOUSE_ID);
    expect(createArg.rackNumber).toBe('R-42');
    expect(createArg.rackRow).toBe('B');
    // Derived name: rackNumber-rackRow
    expect(createArg.name).toBe('R-42-B');

    // Transfer was called AFTER create, using the newly created id
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: newLocId,
      quantity: 3,
      notes: undefined,
    });

    // create happened before transfer
    expect(callOrder).toEqual(['create', 'transfer']);

    // The label stamp comes from the RESOLVED location row, not from what the
    // user typed. findOrCreateRackOrCrate may return a PRE-EXISTING row (a
    // case-insensitive name match), and that row's columns are the truth about
    // that rack/crate — see test 8 for the divergent case.
    expect(mockStampPlacementBin).toHaveBeenCalledWith([ITEM_ID], {
      kind: 'rack',
      rackNumber: 'R-42',
      rackRow: 'B',
      name: 'R-42-B',
      crateColor: null,
      crateNumber: null,
    });

    // Action returns ok with the new location id
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(newLocId);
  });

  it('3. rejects non-positive quantity without calling transfer or create', async () => {
    const zeroResult = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 0,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(zeroResult.ok).toBe(false);
    if (!zeroResult.ok) expect(zeroResult.error.code).toBe('validation_error');

    const negResult = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: -1,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(negResult.ok).toBe(false);
    if (!negResult.ok) expect(negResult.error.code).toBe('validation_error');

    // No transfer or location creation was attempted
    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
  });

  it('4. maps an insufficient_stock RPC error to a friendly message (not raw internal_error)', async () => {
    // transfer_stock raises P0001 `insufficient_stock`; the service wraps it as
    // ServiceError('internal_error', '...insufficient_stock...').
    mockTransferStock.mockRejectedValueOnce(
      new ServiceError('internal_error', 'insufficient_stock: cannot move 100 of 5'),
    );

    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 100,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe("Can't place more than is available.");
    }
  });

  it('5. (FIX A) rejects an existingLocationId NOT in the caller org — no transfer', async () => {
    // Org-scoped lookup returns no row (forged/cross-tenant location id).
    installContext({ locationRow: null });

    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toMatch(/not found in your organization/i);
    }
    // The cross-tenant write never reaches transfer_stock.
    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
  });

  it('6. (FIX A) rejects placing INTO a staging/unplaced bucket', async () => {
    installContext({ locationRow: { id: EXISTING_LOC, warehouse_id: WAREHOUSE_ID, kind: 'staging' } });

    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/rack or crate/i);
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('7. (FIX A) rejects a newRack under a warehouse NOT in the caller org — no create/transfer', async () => {
    installContext({ warehouseRow: null });

    const result = await placeStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: {
        newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-42' },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/warehouse not found in your organization/i);
    expect(mockFindOrCreateRackOrCrate).not.toHaveBeenCalled();
    expect(mockTransferStock).not.toHaveBeenCalled();
  });
});
