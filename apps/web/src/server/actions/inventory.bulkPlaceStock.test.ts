import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Same hoisted-mock pattern as inventory.placeStock.test.ts: bulkPlaceStockAction
// resolves withContext() once, then uses ctx.supabase for the destination
// org-verification and new InventoryService/LocationsService for the writes.
const { mockTransferStock, mockCreateLocation, ctxRef } = vi.hoisted(() => ({
  mockTransferStock: vi.fn(async () => undefined),
  mockCreateLocation: vi.fn(async () => ({ id: 'new-loc-99' })),
  ctxRef: { ctx: null as unknown },
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, withContext: vi.fn(async () => ctxRef.ctx) };
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
  mockCreateLocation.mockResolvedValue({ id: 'new-loc-99' });
  installContext();
});

describe('bulkPlaceStockAction', () => {
  it('1. places every item into ONE existing rack (full qty each), no location created', async () => {
    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { existingLocationId: EXISTING_LOC },
    });

    expect(mockCreateLocation).not.toHaveBeenCalled();
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
  });

  it('2. creates the new rack ONCE, then places all items into it', async () => {
    const newLocId = '99999999-9999-9999-9999-999999999999';
    mockCreateLocation.mockResolvedValue({ id: newLocId });

    const res = await bulkPlaceStockAction({
      placements: TWO,
      destination: { newRack: { warehouseId: WAREHOUSE_ID, rackNumber: 'BULK-1' } },
    });

    expect(mockCreateLocation).toHaveBeenCalledOnce();
    expect(mockTransferStock).toHaveBeenCalledTimes(2);
    expect(mockTransferStock).toHaveBeenNthCalledWith(1, expect.objectContaining({ toLocationId: newLocId, itemId: ITEM_A }));
    expect(mockTransferStock).toHaveBeenNthCalledWith(2, expect.objectContaining({ toLocationId: newLocId, itemId: ITEM_B }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.placed).toBe(2);
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
