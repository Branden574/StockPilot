import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbPermissionRefusedCopy, ITEM_HOLDS_STOCK_COPY } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ userId: 'user-test', organizationId: 'org-test', role: 'admin' })),
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));

import { ADJUST_LOCATION_WRITE_REFUSED, InventoryService, TRANSFER_WAREHOUSE_WRITE_REFUSED } from './inventory';

/**
 * Migration 0395 (L8, L15): the stock ledger wrappers refuse a direct call by
 * someone without the permission the app checks first (42501 'forbidden',
 * hint permission), and the database refuses to soft-delete an item that
 * still has stock on record or a holding (23514, hint item_holds_stock). The
 * service maps each to its own sentence, checked BEFORE the older 'forbidden'
 * arms: those read any other 42501 as a warehouse or location refusal.
 */

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-test',
  warehouse_id: 'wh-a',
  status: 'active',
  quantity_on_hand: 4,
  reorder_point: 0,
  name: 'Clipboard',
  sku: 'CB-1',
};
const PERMISSION = { message: 'forbidden', code: '42501', hint: 'permission' };
const FORBIDDEN = { message: 'forbidden', code: '42501' };

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.adjustStock — the stock:adjust refusal from the database (0395 L8)', () => {
  function build(error: { message: string; code?: string; hint?: string }) {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:adjust_stock': { data: null, error },
    });
    return { stub, svc: new InventoryService(makeServiceContext(stub.client, { role: 'staff' })) };
  }

  it('names the permission, not the location, when the function refuses for want of stock:adjust', async () => {
    const { svc } = build(PERMISSION);
    await expect(
      svc.adjustStock({ itemId: 'itm-1', quantityChange: -1, movementType: 'remove', locationId: 'loc-a-rack' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: dbPermissionRefusedCopy('adjust') });
  });

  it("keeps the location sentence for the function's other 'forbidden' (no hint)", async () => {
    const { svc } = build(FORBIDDEN);
    await expect(
      svc.adjustStock({ itemId: 'itm-1', quantityChange: -1, movementType: 'remove', locationId: 'loc-a-rack' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: ADJUST_LOCATION_WRITE_REFUSED });
  });
});

describe('InventoryService.transferStock — the stock:transfer refusal from the database (0395 L8)', () => {
  const INPUT = { itemId: 'itm-1', fromLocationId: 'loc-a', toLocationId: 'loc-b', quantity: 2 };
  function build(error: { message: string; code?: string; hint?: string }) {
    const stub = makeSupabaseStub({ 'rpc:transfer_stock': { data: null, error } });
    return new InventoryService(makeServiceContext(stub.client, { role: 'staff' }));
  }

  it('names the permission, not the warehouses, when the function refuses for want of stock:transfer', async () => {
    await expect(build(PERMISSION).transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: dbPermissionRefusedCopy('transfer'),
    });
  });

  it("keeps the warehouse sentence for the function's other 'forbidden' (no hint)", async () => {
    await expect(build(FORBIDDEN).transferStock(INPUT)).rejects.toMatchObject({
      code: 'forbidden',
      message: TRANSFER_WAREHOUSE_WRITE_REFUSED,
    });
  });
});

describe('InventoryService.softDelete — an item that holds stock (0395 L15)', () => {
  // The service refuses an item that reads as holding stock before it writes
  // (small fixes slice 1, the archive guard's check; inventory.test.ts pins
  // it). The database's refusal is what answers when stock arrives between
  // that read and the update, so the item reads empty here.
  it('says the item still holds stock, and what makes it deletable, when the database refuses the delete', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { ...ITEM, quantity_on_hand: 0 }, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'inventory_items.update': {
        data: null,
        error: { message: 'item_holds_stock', code: '23514', hint: 'item_holds_stock' },
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(svc.softDelete('itm-1')).rejects.toMatchObject({
      code: 'validation_error',
      message: ITEM_HOLDS_STOCK_COPY,
    });
  });

  it('keeps any other failure an internal error', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { ...ITEM, quantity_on_hand: 0 }, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'inventory_items.update': { data: null, error: { message: 'connection reset' } },
    });
    const svc = new InventoryService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(svc.softDelete('itm-1')).rejects.toMatchObject({ code: 'internal_error' });
  });
});
