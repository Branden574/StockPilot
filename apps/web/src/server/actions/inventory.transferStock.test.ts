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
// Hoisted mocks — same harness as inventory.placeStock.test.ts.
//
// transferStockAction resolves `withContext()` once, then constructs
// `new InventoryService(ctx)` / `new LocationsService(ctx)` and uses
// `ctx.supabase` directly for the newRack warehouse org-verification. So we
// mock:
//  - withContext() → a ServiceContext-shaped object whose supabase is a
//    configurable stub (controls the warehouses verification row).
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
import { transferStockAction } from './inventory';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FROM_LOC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXISTING_LOC = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WAREHOUSE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ORG_ID = 'org-test';

/**
 * Install a fresh org context whose supabase stub answers the newRack
 * warehouse verification lookup. `warehouseRow` defaults to a valid same-org
 * row; pass `null` to simulate a cross-tenant / missing warehouse.
 */
function installContext(opts: { warehouseRow?: Record<string, unknown> | null } = {}): SupabaseStub {
  const warehouseRow = 'warehouseRow' in opts ? opts.warehouseRow : { id: WAREHOUSE_ID };
  const stub = makeSupabaseStub({
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

describe('transferStockAction (destination union)', () => {
  it('1. transfers to an existing destination without creating a location', async () => {
    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      notes: 'moving stock',
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(mockCreateLocation).not.toHaveBeenCalled();
    expect(mockTransferStock).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: EXISTING_LOC,
      quantity: 5,
      notes: 'moving stock',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(EXISTING_LOC);
  });

  it('2. creates the new rack (org-verified warehouse) then transfers to it', async () => {
    const newLocId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const callOrder: string[] = [];
    mockCreateLocation.mockImplementation(async () => {
      callOrder.push('create');
      return { id: newLocId };
    });
    mockTransferStock.mockImplementation(async () => {
      callOrder.push('transfer');
    });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: {
        newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7', rackRow: 'C' },
      },
    });

    expect(mockCreateLocation).toHaveBeenCalledOnce();
    const createArg = (mockCreateLocation.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.kind).toBe('rack');
    expect(createArg.type).toBe('shelf');
    expect(createArg.warehouseId).toBe(WAREHOUSE_ID);
    expect(createArg.rackNumber).toBe('R-7');
    expect(createArg.name).toBe('R-7-C');

    expect(mockTransferStock).toHaveBeenCalledWith({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      toLocationId: newLocId,
      quantity: 3,
      notes: undefined,
    });
    expect(callOrder).toEqual(['create', 'transfer']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.toLocationId).toBe(newLocId);
  });

  it('3. rejects a newRack under a warehouse NOT in the caller org — no create/transfer', async () => {
    installContext({ warehouseRow: null });

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toMatch(/warehouse not found in your organization/i);
    }
    expect(mockCreateLocation).not.toHaveBeenCalled();
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('4. permission branch: a forbidden LocationsService.create (locations:manage) blocks the transfer', async () => {
    // LocationsService.create asserts 'locations:manage' + the locations plan
    // limit internally — when that throws, the action must surface the error
    // and NEVER run the transfer against a half-created destination.
    mockCreateLocation.mockRejectedValueOnce(new ServiceError('forbidden', 'Permission denied'));

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 3,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'R-7' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(mockTransferStock).not.toHaveBeenCalled();
  });

  it('5. rejects same source/destination and non-positive quantity via schema', async () => {
    const same = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 5,
      destination: { existingLocationId: FROM_LOC },
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.code).toBe('validation_error');

    const zero = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 0,
      destination: { existingLocationId: EXISTING_LOC },
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.code).toBe('validation_error');

    expect(mockTransferStock).not.toHaveBeenCalled();
    expect(mockCreateLocation).not.toHaveBeenCalled();
  });

  it('6. maps an insufficient_stock RPC error to a friendly message', async () => {
    mockTransferStock.mockRejectedValueOnce(
      new ServiceError('internal_error', 'insufficient_stock: cannot move 100 of 5'),
    );

    const result = await transferStockAction({
      itemId: ITEM_ID,
      fromLocationId: FROM_LOC,
      quantity: 100,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_error');
      expect(result.error.message).toBe("Can't transfer more than is available.");
    }
  });
});
