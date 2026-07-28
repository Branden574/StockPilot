import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { InventoryService } from './inventory';

// A minimal create payload — the gate must fire BEFORE any DB write, so the
// stub returning nulls is fine.
const base = {
  name: 'Milk', unitCost: 0, retailPrice: 0, quantityOnHand: 0, reorderPoint: 0,
  reorderQuantity: 0, unitOfMeasure: 'each', trackingType: 'none' as const,
  itemType: 'product' as const, customFields: {}, status: 'active' as const,
  expiryPolicy: 'warn' as const,
};

/** One bulkCreate row. Only `trackingType` matters to the gate under test. */
const bulkItem = {
  name: 'Milk',
  barcode: 'B1',
  itemType: 'product' as const,
  quantityOnHand: 0,
  unitCost: 0,
  retailPrice: 0,
};

describe('InventoryService lot gate', () => {
  it('rejects creating a lot-tracked item when lot_serial is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client)); // no lot_serial
    await expect(svc.create({ ...base, trackingType: 'lot' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('rejects a non-default expiry_policy on create when lot_serial is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client)); // no lot_serial
    // trackingType 'none', no shelfLifeDays — only the expiryPolicy trips the gate.
    await expect(svc.create({ ...base, expiryPolicy: 'block' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  // bulkCreate (the CSV / scan import path) accepted `trackingType`, including
  // 'serial_optional', with NO module gate at all — the cheapest way in the app
  // to mint lot/serial-tracked rows in an org that never enabled the module,
  // 500 at a time. It carries no categoryId, so nothing on this path can be
  // sports-granted the way create()'s category carve-out is: the whole matrix
  // reduces to "non-'none' belongs to lot_serial".
  it('rejects a bulk import requesting serial_optional when lot_serial is disabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client)); // no lot_serial
    await expect(
      svc.bulkCreate({
        warehouseId: 'wh-1',
        items: [
          { ...bulkItem, trackingType: 'none' },
          { ...bulkItem, barcode: 'B2', trackingType: 'serial_optional' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.chains.has('inventory_items.insert')).toBe(false);
  });

  it('rejects every non-none bulk tracking type when lot_serial is disabled', async () => {
    for (const trackingType of ['lot', 'serial', 'serial_optional'] as const) {
      const stub = makeSupabaseStub({});
      const svc = new InventoryService(makeServiceContext(stub.client));
      await expect(
        svc.bulkCreate({ warehouseId: 'wh-1', items: [{ ...bulkItem, trackingType }] }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
    }
  });

  it('leaves an all-none bulk import untouched by the gate', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client));
    // Runs all the way through against the empty stub — the gate did not fire.
    await expect(
      svc.bulkCreate({ warehouseId: 'wh-1', items: [{ ...bulkItem, trackingType: 'none' }] }),
    ).resolves.toMatchObject({ created: 0 });
  });

  it('leaves a bulk import that omits trackingType entirely untouched', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client));
    await expect(
      svc.bulkCreate({ warehouseId: 'wh-1', items: [{ ...bulkItem }] }),
    ).resolves.toMatchObject({ created: 0 });
  });

  it('allows tracking_type none when lot_serial is disabled', async () => {
    // create() proceeds past the gate; we only assert the gate does NOT fire.
    // The stub returns nulls downstream so create() rejects on an unrelated
    // warehouse/plan error — that's fine: it proves the gate did NOT throw
    // module_disabled for a non-lot item.
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client));
    await expect(svc.create({ ...base })).rejects.not.toMatchObject({
      code: 'module_disabled',
    });
  });
});
