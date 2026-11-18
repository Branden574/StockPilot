import { revalidatePath, revalidateTag } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withContext } from '@/server/services/context';
import { UserCategoriesService } from '@/server/services/user-categories';
import { expectCatalogExpiryReaches } from '@/test/orders-catalog-tags';

import { setUserCategoryAccessAction } from './user-categories';

/**
 * Saving a member's category access marks this organization's Place an Order
 * catalog entries for a background refresh, and only this organization's. The
 * new visibility does not wait for it: the catalog's access key is resolved
 * live per request from the member's grants.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/server/services/user-categories', () => ({ UserCategoriesService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const WH = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-0000000000e1';
const CATEGORY = '00000000-0000-4000-8000-0000000000f1';

const setUserCategoryAccess = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withContext).mockResolvedValue({
    organizationId: ORG,
    userId: 'u-1',
    role: 'admin',
  } as never);
  vi.mocked(UserCategoriesService).mockImplementation(function () {
    return { setUserCategoryAccess } as unknown as InstanceType<typeof UserCategoriesService>;
  });
});

describe('setUserCategoryAccessAction', () => {
  it("marks this organization's catalog entries only, and refreshes the list pages", async () => {
    const res = await setUserCategoryAccessAction({ userId: MEMBER, categoryIds: [CATEGORY] });
    expect(res).toEqual({ ok: true, data: { count: 1 } });
    expect(setUserCategoryAccess).toHaveBeenCalledWith(MEMBER, [CATEGORY]);
    expect(vi.mocked(revalidateTag).mock.calls).toEqual([[`orders-new-v2-catalog:${ORG}`, 'max']]);
    expectCatalogExpiryReaches(
      vi.mocked(revalidateTag).mock.calls.map((c) => c[0]),
      { hits: [[ORG, WH]], misses: [[OTHER_ORG, WH]] },
    );
    expect(
      vi
        .mocked(revalidatePath)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(['/dashboard/books', '/dashboard/inventory', '/dashboard/team']);
  });

  it('a refused save marks nothing', async () => {
    setUserCategoryAccess.mockRejectedValueOnce(new Error('boom'));
    const res = await setUserCategoryAccessAction({ userId: MEMBER, categoryIds: [CATEGORY] });
    expect(res.ok).toBe(false);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
