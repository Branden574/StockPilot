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

// The context-building list invalidation: spied on so the adjust action can be
// held to NOT calling it (its service already invalidates, see below).
const revalidateForCurrentOrg = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/server/loaders/inventory-list', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/loaders/inventory-list')>()),
  revalidateInventoryListForCurrentOrg: revalidateForCurrentOrg,
}));

import { revalidatePath } from 'next/cache';

import { InventoryService } from '@/server/services/inventory';
import { ServiceError } from '@/server/services/context';

import { adjustStockAction, bulkUpdateInventoryAction } from './inventory';

describe('adjustStockAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adjusts, re-renders through revalidatePath, and builds no second context', async () => {
    const adjustStock = vi.fn(async () => undefined);
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({ adjustStock } as any);

    const itemId = '11111111-1111-4111-8111-111111111111';
    const result = await adjustStockAction({ itemId, quantityChange: 1, movementType: 'add' });

    expect(result.ok).toBe(true);
    expect(adjustStock).toHaveBeenCalledTimes(1);
    // These are what put the re-rendered page into the action's response.
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/inventory');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/inventory/${itemId}`);
    // InventoryService.adjustStock expires the org's list itself
    // (invalidateInventoryListAfterWrite 'stock.adjust'); a second expiry here
    // built a whole new service context in the action (cache() does not
    // memoize there) between the commit and the re-render.
    expect(revalidateForCurrentOrg).not.toHaveBeenCalled();
  });

  it('a refused adjustment revalidates nothing', async () => {
    const adjustStock = vi.fn(async () => {
      throw new ServiceError('validation_error', 'Insufficient stock for this adjustment');
    });
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({ adjustStock } as any);

    const result = await adjustStockAction({
      itemId: '11111111-1111-4111-8111-111111111111',
      quantityChange: 1,
      movementType: 'add',
    });

    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(revalidateForCurrentOrg).not.toHaveBeenCalled();
  });
});

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

  // A bulk tag list rides in the URL of every batch of item ids, so it is
  // capped (MAX_BULK_TAGS = 50) and shape-checked before any work.
  it('refuses more than 50 tags, before the service is built', async () => {
    const tagIds = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const kind of ['add_tags', 'remove_tags'] as const) {
      const result = await bulkUpdateInventoryAction({ ids: ['a'], op: { kind, tagIds } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('Apply or remove at most 50 tags at a time.');
    }
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();
  });

  it('refuses a malformed tag id, and passes 50 well-formed ones through', async () => {
    const bad = await bulkUpdateInventoryAction({
      ids: ['a'],
      op: { kind: 'add_tags', tagIds: ['not-a-uuid'] },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('validation_error');
    expect(InventoryService.forCurrentUser).not.toHaveBeenCalled();

    const bulkUpdate = vi.fn(async () => ({ ok: 1, skipped: 0 }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({ bulkUpdate } as any);
    const tagIds = Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const good = await bulkUpdateInventoryAction({ ids: ['a'], op: { kind: 'add_tags', tagIds } });
    expect(good.ok).toBe(true);
  });

  it('passes a partial write\'s failed count through to the toolbar', async () => {
    const bulkUpdate = vi.fn(async () => ({ ok: 100, skipped: 0, failed: 150 }));
    vi.mocked(InventoryService.forCurrentUser).mockResolvedValue({ bulkUpdate } as any);
    const result = await bulkUpdateInventoryAction({ ids: ['a'], op: { kind: 'archive' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.failed).toBe(150);
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
