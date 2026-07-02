import { beforeEach, describe, expect, it, vi } from 'vitest';

// unstable_cache/revalidateTag: the actions under test import the
// inventory-list loader (cache invalidation helper), whose module graph
// builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn() },
}));

import { revalidatePath } from 'next/cache';

import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';

import { bulkCreateBooksAction } from './books-bulk-import';

const WAREHOUSE_ID = '11111111-1111-1111-1111-111111111111';

function makeBook(overrides: Partial<{ isbn: string; title: string }> = {}) {
  return {
    isbn: '9780140449136',
    title: 'War and Peace',
    quantityOnHand: 1,
    unitCost: 0,
    retailPrice: 0,
    ...overrides,
  };
}

describe('bulkCreateBooksAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty books array as validation_error', async () => {
    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects malformed isbn (too short)', async () => {
    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [makeBook({ isbn: '123' })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects invalid warehouse uuid', async () => {
    const result = await bulkCreateBooksAction({
      warehouseId: 'not-a-uuid',
      books: [makeBook()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('happy path: calls bulkCreate once, revalidates dashboard paths', async () => {
    const bulkCreate = vi.fn(async () => ({
      created: 1,
      skipped: 0,
      errors: [],
      createdIds: ['item-1'],
    }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkCreate,
       
    } as any);

    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [makeBook({ isbn: '9780140449136', title: 'A' })],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.skipped).toBe(0);
      expect(result.data.errors).toEqual([]);
    }
    expect(bulkCreate).toHaveBeenCalledTimes(1);
    expect(bulkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseId: WAREHOUSE_ID,
        items: expect.arrayContaining([
          expect.objectContaining({
            name: 'A',
            barcode: '9780140449136',
            itemType: 'book',
          }),
        ]),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/inventory');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/books');
  });

  it('translates skipped barcodes through unchanged', async () => {
    const bulkCreate = vi.fn(async () => ({
      created: 1,
      skipped: 1,
      errors: [],
      createdIds: ['item-1'],
    }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkCreate,
       
    } as any);

    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [
        makeBook({ isbn: '9780140449136', title: 'A' }),
        makeBook({ isbn: '9780393310733', title: 'B' }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.skipped).toBe(1);
    }
  });

  it('maps service errors[].barcode → isbn for the client', async () => {
    const bulkCreate = vi.fn(async () => ({
      created: 1,
      skipped: 0,
      errors: [{ barcode: '9780393310733', reason: 'something' }],
      createdIds: ['item-1'],
    }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkCreate,
       
    } as any);

    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [makeBook({ isbn: '9780140449136', title: 'A' })],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.errors).toEqual([
        { isbn: '9780393310733', reason: 'something' },
      ]);
    }
  });

  it('surfaces ServiceError from bulkCreate as the action error', async () => {
    const bulkCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new ServiceError(
          'plan_limit_exceeded',
          'Importing 5 items would exceed your Free plan limit of 100 items.',
        ),
      );
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkCreate,
       
    } as any);

    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [makeBook({ isbn: '9780140449136', title: 'A' })],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('plan_limit_exceeded');
      expect(result.error.message).toMatch(/Free plan limit of 100 items/);
    }
  });
});
