import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

vi.mock('./inventory', () => ({
  InventoryService: vi.fn(),
}));

import { createAdminClient } from '@/lib/supabase/admin';
import { InventoryService } from './inventory';
import {
  itemKey,
  restoreSnapshot,
  RESTORE_CONFIRM_PHRASE,
  SNAPSHOT_FORMAT_VERSION,
  type RestoreSnapshot,
  type SnapshotItem,
} from './restore-points';

const BUSINESS_ORG_ROW = {
  plan: 'business',
  access_tier: null,
  billing_arrangement: null,
  stripe_subscription_id: null,
  trial_ends_at: null,
  trial_tier: null,
};

function baseSnapshotItem(overrides: Partial<SnapshotItem>): SnapshotItem {
  return {
    sku: 'SKU-1',
    name: 'Widget',
    barcode: null,
    description: null,
    unitCost: 0,
    retailPrice: 0,
    quantityOnHand: 0,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitOfMeasure: 'unit',
    status: 'active',
    itemType: 'product',
    warehouseId: 'wh-1',
    binLocation: 'A-1',
    categoryName: null,
    supplierName: null,
    locationName: null,
    charterId: null,
    ...overrides,
  };
}

describe('itemKey', () => {
  it('differs for two same-(sku,bin) rows under different charters (no collapse)', () => {
    const keyA = itemKey('SKU-1', 'A-1', 'charter-a');
    const keyB = itemKey('SKU-1', 'A-1', 'charter-b');
    expect(keyA).not.toBe(keyB);
  });

  it('is stable for the same (sku, bin, charter) triple', () => {
    expect(itemKey('SKU-1', 'A-1', 'charter-a')).toBe(itemKey('SKU-1', 'A-1', 'charter-a'));
  });

  it('treats null and generic-stock charter consistently (both blank segment)', () => {
    expect(itemKey('SKU-1', 'A-1', null)).toBe(itemKey('SKU-1', 'A-1', null));
    expect(itemKey('SKU-1', 'A-1', null)).not.toBe(itemKey('SKU-1', 'A-1', 'charter-a'));
  });
});

describe('restoreSnapshot — charter-aware reconcile (round trip)', () => {
  let updateSpy: ReturnType<typeof vi.fn>;
  let createSpy: ReturnType<typeof vi.fn>;
  let adjustStockSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    updateSpy = vi.fn(async () => undefined);
    createSpy = vi.fn(async () => ({ id: 'new-id' }));
    adjustStockSpy = vi.fn(async () => undefined);
    vi.mocked(InventoryService).mockImplementation(
      () =>
        ({ update: updateSpy, create: createSpy, adjustStock: adjustStockSpy }) as unknown as InstanceType<
          typeof InventoryService
        >,
    );

    const adminStub = makeSupabaseStub({
      'restore_points.insert': { data: { id: 'pre-restore-id' }, error: null },
      'restore_points.select': { data: [], error: null }, // pruneSnapshots: nothing stale
    });
    vi.mocked(createAdminClient).mockReturnValue(adminStub.client);
  });

  /**
   * TWO placements share the same (sku, bin_location) but live under
   * different charters — legal under Model B (0008_warehouse_charters).
   * A snapshot captured earlier has both; the org's live rows still have
   * both (at different quantities, to force an adjustStock per row). The
   * old itemKey(sku, bin) collapsed these onto ONE map entry, so only the
   * last-registered active row would ever be reconciled — the other
   * placement's snapshot entry silently matched the WRONG row (or double
   * -touched the same row) and its own quantity was never restored.
   */
  it('reconciles BOTH same-(sku,bin) placements under different charters, not just one', async () => {
    const snapshot: RestoreSnapshot = {
      version: SNAPSHOT_FORMAT_VERSION,
      capturedAt: '2026-07-01T00:00:00.000Z',
      items: [
        baseSnapshotItem({ charterId: 'charter-a', quantityOnHand: 12 }),
        baseSnapshotItem({ charterId: 'charter-b', quantityOnHand: 30 }),
      ],
    };

    const stub = makeSupabaseStub({
      'organizations.select': { data: BUSINESS_ORG_ROW, error: null },
      'restore_points.select': { data: { snapshot }, error: null },
      'inventory_items.select': {
        data: [
          {
            id: 'item-1',
            sku: 'SKU-1',
            name: 'Widget',
            bin_location: 'A-1',
            quantity_on_hand: 5,
            status: 'active',
            charter_id: 'charter-a',
            barcode: null,
            description: null,
            unit_cost: 0,
            retail_price: 0,
            reorder_point: 0,
            reorder_quantity: 0,
            unit_of_measure: 'unit',
            item_type: 'product',
            warehouse_id: 'wh-1',
            category: null,
            supplier: null,
            location: null,
          },
          {
            id: 'item-2',
            sku: 'SKU-1',
            name: 'Widget',
            bin_location: 'A-1',
            quantity_on_hand: 3,
            status: 'active',
            charter_id: 'charter-b',
            barcode: null,
            description: null,
            unit_cost: 0,
            retail_price: 0,
            reorder_point: 0,
            reorder_quantity: 0,
            unit_of_measure: 'unit',
            item_type: 'product',
            warehouse_id: 'wh-1',
            category: null,
            supplier: null,
            location: null,
          },
        ],
        error: null,
      },
    });
    stub.client.auth.mfa.getAuthenticatorAssuranceLevel = vi.fn(async () => ({
      data: { currentLevel: 'aal2' },
      error: null,
    }));

    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    const result = await restoreSnapshot(ctx as never, {
      id: 'rp-1',
      confirm: RESTORE_CONFIRM_PHRASE,
    });

    // Both existing rows were reconciled by UPDATE — never collapsed onto one.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const updatedIds = updateSpy.mock.calls.map((call) => call[0]).sort();
    expect(updatedIds).toEqual(['item-1', 'item-2']);

    // Each row's quantity delta was computed against ITS OWN prior qty —
    // proof the two snapshot entries were not merged onto a single key.
    expect(adjustStockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-1', quantityChange: 7 }),
    );
    expect(adjustStockSpy).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'item-2', quantityChange: 27 }),
    );

    // Neither placement was missing, so nothing should have been recreated.
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.updated).toBe(2);
    expect(result.recreated).toBe(0);
    expect(result.failures).toBe(0);
  });

  it('rejects restoring an older-format snapshot instead of silently misreading it', async () => {
    const oldSnapshot = {
      version: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      items: [baseSnapshotItem({ charterId: 'charter-a' })],
    };
    const stub = makeSupabaseStub({
      'organizations.select': { data: BUSINESS_ORG_ROW, error: null },
      'restore_points.select': { data: { snapshot: oldSnapshot }, error: null },
    });
    stub.client.auth.mfa.getAuthenticatorAssuranceLevel = vi.fn(async () => ({
      data: { currentLevel: 'aal2' },
      error: null,
    }));

    const ctx = makeServiceContext(stub.client, { role: 'owner' });
    await expect(
      restoreSnapshot(ctx as never, { id: 'rp-old', confirm: RESTORE_CONFIRM_PHRASE }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // Must bail out before touching InventoryService at all.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
