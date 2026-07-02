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

import { bulkUpdateInventoryAction } from './inventory';

describe('bulkUpdateInventoryAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns validation_error when ids array is empty', async () => {
    const result = await bulkUpdateInventoryAction({
      ids: [],
      op: { kind: 'archive' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();
  });

  it('returns validation_error when ids contains a non-string entry', async () => {
    const result = await bulkUpdateInventoryAction({
       
      ids: ['ok-id', 42 as any],
      op: { kind: 'archive' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();
  });

  it('returns validation_error on empty-string id', async () => {
    const result = await bulkUpdateInventoryAction({
      ids: ['valid', ''],
      op: { kind: 'archive' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });

  it('returns ok with bulkUpdate counts and revalidates on success', async () => {
    const bulkUpdate = vi.fn(async () => ({ ok: 3, skipped: 1 }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkUpdate,
       
    } as any);

    const result = await bulkUpdateInventoryAction({
      ids: ['a', 'b', 'c', 'd'],
      op: { kind: 'archive' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ ok: 3, skipped: 1 });
    expect(bulkUpdate).toHaveBeenCalledWith({
      ids: ['a', 'b', 'c', 'd'],
      op: { kind: 'archive' },
    });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/inventory');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/books');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
  });

  it('maps ServiceError to err result code', async () => {
    const bulkUpdate = vi.fn(async () => {
      throw new ServiceError('forbidden', 'no permission');
    });
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({
      bulkUpdate,
       
    } as any);

    const result = await bulkUpdateInventoryAction({
      ids: ['a'],
      op: { kind: 'archive' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toBe('no permission');
    }
  });
});
