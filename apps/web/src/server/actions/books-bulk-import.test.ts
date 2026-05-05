import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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

  it('treats conflict on a single row as skipped, not an error', async () => {
    const create = vi
      .fn()
      // first book: ok
      .mockResolvedValueOnce({ id: 'item-1' })
      // second book: conflict
      .mockRejectedValueOnce(new ServiceError('conflict', 'duplicate barcode'));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      create,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      expect(result.data.errors).toEqual([]);
    }
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/books');
  });

  it('aggregates non-conflict ServiceErrors into errors[]', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: 'item-1' })
      .mockRejectedValueOnce(new ServiceError('forbidden', 'nope'))
      .mockRejectedValueOnce(new Error('boom'));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      create,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await bulkCreateBooksAction({
      warehouseId: WAREHOUSE_ID,
      books: [
        makeBook({ isbn: '9780140449136', title: 'A' }),
        makeBook({ isbn: '9780393310733', title: 'B' }),
        makeBook({ isbn: '9780199536566', title: 'C' }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.skipped).toBe(0);
      expect(result.data.errors).toHaveLength(2);
      expect(result.data.errors[0]).toEqual({
        isbn: '9780393310733',
        reason: 'nope',
      });
      expect(result.data.errors[1]).toEqual({
        isbn: '9780199536566',
        reason: 'boom',
      });
    }
  });

  it('happy path: all created, no errors, no skips, revalidates dashboard paths', async () => {
    const create = vi.fn(async () => ({ id: 'item' }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      create,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/inventory');
  });
});
