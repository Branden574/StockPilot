import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));

import { InventoryService } from './inventory';

const BASE_INPUT = {
  baseName: 'L4L Black T-Shirt',
  baseSku: 'SP-OKX68-UAA',
  baseBarcode: null,
  description: null,
  categoryId: 'cat-1',
  supplierId: null,
  warehouseId: 'wh-1',
  charterId: null,
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 12,
  unitCost: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
  unitOfMeasure: 'unit',
};

/**
 * Builds a Supabase stub that handles two tables:
 *   - inventory_items: the insert that returns the rows back so the
 *     service can hand them to the action.
 *   - stock_movements: the post-insert audit-log writeback. The service
 *     swallows movement-log errors, so an absent table just no-ops here.
 */
function buildStub() {
  const insertedItems: Array<Record<string, unknown>> = [];
  const insertedMovements: Array<Record<string, unknown>> = [];
  return {
    insertedItems,
    insertedMovements,
     
    from(table: string): any {
      if (table === 'inventory_items') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            insertedItems.push(...rows);
            return {
              select: () => ({
                 
                then: (cb: any) =>
                  cb({
                    data: rows.map((r, i) => ({ ...r, id: `i-${i}` })),
                    error: null,
                  }),
              }),
            };
          },
        };
      }
      if (table === 'stock_movements') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            insertedMovements.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'warehouse_charters') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { charter_id: 'ch-1' } }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function makeSvc(stub: ReturnType<typeof buildStub>) {
  return new InventoryService({
     
    supabase: stub as any,
    organizationId: 'org-1',
    userId: 'u1',
    email: 'a@b.c',
    role: 'admin',
     
  } as any);
}

describe('InventoryService.bulkCreateSizedVariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts one row per size with name + sku + custom_fields.size suffixed', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    const res = await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: 'S', quantity: 3 },
        { size: 'M', quantity: 5 },
      ],
    });

    expect(stub.insertedItems).toHaveLength(2);
    expect(stub.insertedItems[0]?.name).toBe('L4L Black T-Shirt - S');
    expect(stub.insertedItems[0]?.sku).toBe('SP-OKX68-UAA-S');
    expect(stub.insertedItems[0]?.quantity_on_hand).toBe(3);
    expect(stub.insertedItems[0]?.unit_of_measure).toBe('unit');
    expect(stub.insertedItems[0]?.charter_id).toBeNull();
    expect((stub.insertedItems[0]?.custom_fields as Record<string, unknown>).size).toBe('S');
    expect(stub.insertedItems[1]?.name).toBe('L4L Black T-Shirt - M');
    expect(stub.insertedItems[1]?.sku).toBe('SP-OKX68-UAA-M');
    expect(res).toHaveLength(2);
  });

  it('writes stock_movements for non-zero variants only', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);

    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: 'S', quantity: 0 },
        { size: 'M', quantity: 4 },
      ],
    });

    expect(stub.insertedMovements).toHaveLength(1);
    expect(stub.insertedMovements[0]?.quantity_change).toBe(4);
    expect(stub.insertedMovements[0]?.movement_type).toBe('initial');
  });

  it('throws when variants is empty', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);
    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [],
      }),
    ).rejects.toThrow(/at least one size/i);
  });

  it('null baseSku auto-generates a shared base and suffixes per variant', async () => {
    const stub = buildStub();
    const svc = makeSvc(stub);
    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      baseSku: null,
      variants: [
        { size: 'L', quantity: 1 },
        { size: 'XL', quantity: 2 },
      ],
    });
    const skuL = stub.insertedItems[0]?.sku as string;
    const skuXL = stub.insertedItems[1]?.sku as string;
    expect(typeof skuL).toBe('string');
    expect(skuL.endsWith('-L')).toBe(true);
    expect(skuXL.endsWith('-XL')).toBe(true);
    // Both variants share the SAME generated base.
    expect(skuL.replace(/-L$/, '')).toBe(skuXL.replace(/-XL$/, ''));
  });
});
