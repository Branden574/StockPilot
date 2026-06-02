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
