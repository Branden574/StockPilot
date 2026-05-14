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
  primaryLocationId: null,
  binLocation: null,
  retailPrice: 12,
  unitCost: 4,
  reorderPoint: 0,
  reorderQuantity: 0,
};

describe('InventoryService.bulkCreateSizedVariants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts one row per size with name + sku + custom_fields.size suffixed', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      insert: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return {
          select: () => ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then: (cb: any) =>
              cb({
                data: rows.map((r, i) => ({ ...r, id: `i-${i}` })),
                error: null,
              }),
          }),
        };
      },
    };
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      variants: [
        { size: 'S', quantity: 3 },
        { size: 'M', quantity: 5 },
      ],
    });

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.name).toBe('L4L Black T-Shirt - S');
    expect(inserted[0]?.sku).toBe('SP-OKX68-UAA-S');
    expect(inserted[0]?.quantity_on_hand).toBe(3);
    expect((inserted[0]?.custom_fields as Record<string, unknown>).size).toBe('S');
    expect(inserted[1]?.name).toBe('L4L Black T-Shirt - M');
    expect(inserted[1]?.sku).toBe('SP-OKX68-UAA-M');
    expect(res).toHaveLength(2);
  });

  it('throws when variants is empty', async () => {
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await expect(
      svc.bulkCreateSizedVariants({
        ...BASE_INPUT,
        variants: [],
      }),
    ).rejects.toThrow(/at least one size/i);
  });

  it('null baseSku produces null sku per variant', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      insert: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return {
          select: () => ({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            then: (cb: any) =>
              cb({
                data: rows.map((r, i) => ({ ...r, id: `i-${i}` })),
                error: null,
              }),
          }),
        };
      },
    };
    const svc = new InventoryService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from: () => chain } as any,
      organizationId: 'org-1',
      userId: 'u1',
      email: 'a@b.c',
      role: 'admin',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await svc.bulkCreateSizedVariants({
      ...BASE_INPUT,
      baseSku: null,
      variants: [{ size: 'L', quantity: 1 }],
    });
    expect(inserted[0]?.sku).toBeNull();
  });
});
