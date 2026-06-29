import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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
//    instances expose transferStock / create spies.
// ---------------------------------------------------------------------------

const { mockTransferStock, mockCreateLocation, ctxRef } = vi.hoisted(() => ({
  mockTransferStock: vi.fn(async () => undefined),
  mockCreateLocation: vi.fn(async () => ({ id: 'new-loc-99' })),
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
  },
}));

vi.mock('@/server/services/locations', () => ({
  LocationsService: class {
    create = mockCreateLocation;
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
  mockCreateLocation.mockResolvedValue({ id: 'new-loc-99' });
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
    expect(mockCreateLocation).not.toHaveBeenCalled();

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
  });

  it('2. creates a rack then transfers to the new location id', async () => {
    const newLocId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    const callOrder: string[] = [];
    mockCreateLocation.mockImplementation(async () => {
      callOrder.push('create');
      return { id: newLocId };
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

    // Location was created with kind='rack' (no crateColor)
    expect(mockCreateLocation).toHaveBeenCalledOnce();
    const createArg = (mockCreateLocation.mock.calls[0] as unknown as [Record<string, unknown>])[0];
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
    expect(mockCreateLocation).not.toHaveBeenCalled();
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
    expect(mockCreateLocation).not.toHaveBeenCalled();
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
    expect(mockCreateLocation).not.toHaveBeenCalled();
    expect(mockTransferStock).not.toHaveBeenCalled();
  });
});
