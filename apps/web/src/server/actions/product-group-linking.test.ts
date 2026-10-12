import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Product groups unlink action (PR #361 re-review): when the item left its
// family but its SKU's record on another rack could not follow, the write
// happened, so the caches are refreshed as on success; a refusal that wrote
// nothing refreshes nothing.

const h = vi.hoisted(() => ({
  unlinkItems: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateList: vi.fn(async () => {}),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: h.revalidateList,
}));
vi.mock('@/server/services/product-group-linking', () => ({
  linkFamily: vi.fn(),
  unlinkItems: h.unlinkItems,
}));
vi.mock('@/server/services/product-groups', () => ({ ProductGroupsService: class {} }));
vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'u-1', supabase: {} })),
  };
});

import { ServiceError } from '@/server/services/context';

import { unlinkItemsAction } from './product-group-linking';

const ITEM = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unlinkItemsAction', () => {
  it('refreshes the caches and answers the records that left', async () => {
    h.unlinkItems.mockResolvedValueOnce({ unlinked: 1, skuSiblingIds: [] });
    const r = await unlinkItemsAction({ itemIds: [ITEM], reason: 'Wrong family' });
    expect(r).toEqual({ ok: true, data: { unlinked: 1, skuSiblingIds: [] } });
    expect(h.revalidateList).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith('/dashboard/product-groups');
  });

  it('when the other racks could not follow: says so in its own words, and refreshes the caches all the same', async () => {
    h.unlinkItems.mockRejectedValueOnce(
      new ServiceError('conflict', 'Unlink that record too.', {
        reason: 'sku_siblings_unfinished',
        skuSiblingIds: [],
      }),
    );
    const r = await unlinkItemsAction({ itemIds: [ITEM], reason: 'Wrong family' });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: 'Unlink that record too.' },
    });
    expect(h.revalidateList).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith('/dashboard/product-groups');
    expect(h.revalidatePath).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('a refusal that wrote nothing refreshes nothing', async () => {
    h.unlinkItems.mockRejectedValueOnce(new ServiceError('forbidden', 'Not allowed.'));
    const r = await unlinkItemsAction({ itemIds: [ITEM], reason: 'Wrong family' });
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(h.revalidateList).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
