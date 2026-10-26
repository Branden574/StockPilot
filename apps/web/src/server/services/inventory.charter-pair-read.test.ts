import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every write that sets a record's charter first checks that the warehouse
 * services it (warehouse_charters). Each copy of that check ignored a failed
 * read and answered "This charter is not serviced by the chosen warehouse",
 * which is not what happened: the person was told to pick another charter for
 * an outage. They now refuse as an internal error (still fail closed, nothing
 * written). The item form's edit is pinned in inventory.charter-edit.test.ts;
 * these are the three create paths: New item, Add sizes, and the bulk create
 * behind the books import.
 */

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { InventoryService } from './inventory';

function harness() {
  const stub = makeSupabaseStub({
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'warehouse_charters.select': { data: null, error: { message: 'upstream timeout' } },
    'categories.select': { data: null, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
  });
  const svc = new InventoryService(
    makeServiceContext(stub.client, { organizationId: 'org-1' }) as never,
  );
  /** Every table an INSERT was sent to. */
  const inserts = () =>
    [...stub.chainsAll.entries()].flatMap(([table, chains]) =>
      chains.filter((c) => c.includes('insert')).map(() => table),
    );
  return { svc, inserts };
}

beforeEach(() => vi.clearAllMocks());

describe('a failed read of the warehouse and charter pairing refuses honestly', () => {
  it('New item', async () => {
    const { svc, inserts } = harness();
    const err = (await svc
      .create({
        name: 'Chromebook',
        sku: 'CB-1',
        warehouseId: 'wh-1',
        charterId: 'charter-north',
        quantityOnHand: 0,
        unitCost: 0,
        retailPrice: 0,
      } as never)
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).not.toMatch(/not serviced/i);
    expect(inserts()).toEqual([]);
  });

  it('Add sizes', async () => {
    const { svc, inserts } = harness();
    const err = (await svc
      .bulkCreateSizedVariants({
        baseName: 'Black Tee',
        baseSku: 'SP-TEE',
        baseBarcode: null,
        description: null,
        categoryId: 'cat-1',
        supplierId: null,
        warehouseId: 'wh-1',
        charterId: 'charter-north',
        primaryLocationId: null,
        binLocation: null,
        retailPrice: 0,
        unitCost: 0,
        reorderPoint: 0,
        reorderQuantity: 0,
        variants: [{ size: 'S', quantity: 0 }],
      } as never)
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).not.toMatch(/not serviced/i);
    expect(inserts()).toEqual([]);
  });

  it('the bulk create behind the books import', async () => {
    const { svc, inserts } = harness();
    const err = (await svc
      .bulkCreate({
        warehouseId: 'wh-1',
        charterId: 'charter-north',
        items: [
          {
            name: 'Persepolis',
            barcode: '9780375714573',
            itemType: 'book',
            quantityOnHand: 0,
            unitCost: 0,
            retailPrice: 0,
          },
        ],
      } as never)
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).not.toMatch(/not serviced/i);
    expect(inserts()).toEqual([]);
  });
});
