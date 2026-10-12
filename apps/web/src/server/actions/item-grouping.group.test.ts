import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS } from '@stockpilot/core';

/**
 * The web side of Group selected (migration 0400): the review dialog's preview
 * and Save (also Remove from group and Rename). Both go through
 * ItemGroupingService, the same service the phone's bearer routes use; Save is
 * rate limited in the same per-user bucket as Ungroup and the routes, runs as
 * the web surface, and refreshes the Items and Books pages and every item
 * page only when something was written.
 */

const h = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  checkRateLimit: vi.fn(),
  applyGrouping: vi.fn(),
  previewGroup: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'user-1', role: 'staff' })),
  };
});
vi.mock('@/server/services/item-grouping', () => ({
  ItemGroupingService: vi.fn(function () {
    return { applyGrouping: h.applyGrouping, previewGroup: h.previewGroup };
  }),
}));

import { ServiceError } from '@/server/services/context';

import { applyGroupingAction, previewGroupingAction } from './item-grouping';

const outcome = (o: 'applied' | 'noop') => ({
  action: 'group',
  outcome: o,
  replay: false,
  created: o === 'applied',
  group: { id: 'g', name: 'Polo', version: 1, itemType: 'product', closed: false },
  changes: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
});

describe('applyGroupingAction', () => {
  it('applies as the web surface in the shared grouping bucket, then refreshes the lists and the item pages', async () => {
    h.applyGrouping.mockResolvedValueOnce({ organizationId: 'org-1', outcome: outcome('applied') });
    const r = await applyGroupingAction({ some: 'body' });
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping:user-1', 30, 60_000);
    expect(h.applyGrouping).toHaveBeenCalledWith({ some: 'body' }, 'web');
    expect(r).toEqual({ ok: true, data: { outcome: outcome('applied') } });
    expect(h.revalidatePath.mock.calls).toEqual([
      ['/dashboard/inventory'],
      ['/dashboard/books'],
      ['/dashboard/inventory/[id]', 'page'],
      ['/dashboard/books/[id]', 'page'],
    ]);
  });

  it('a no-op wrote nothing, so it refreshes nothing', async () => {
    h.applyGrouping.mockResolvedValueOnce({ organizationId: 'org-1', outcome: outcome('noop') });
    expect(await applyGroupingAction({})).toEqual({ ok: true, data: { outcome: outcome('noop') } });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('answers a refusal with its code, words and details', async () => {
    h.applyGrouping.mockRejectedValueOnce(
      new ServiceError('conflict', GROUPING_ERROR_WORDS.membershipConflict, {
        reason: 'membership_conflict',
        itemIds: ['a'],
      }),
    );
    expect(await applyGroupingAction({})).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: GROUPING_ERROR_WORDS.membershipConflict,
        details: { reason: 'membership_conflict', itemIds: ['a'] },
      },
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('is rate limited, and never says more than the generic sentence for an unknown error', async () => {
    h.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      count: 31,
      resetAt: Date.now() + 1000,
    });
    expect(await applyGroupingAction({})).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', message: GROUPING_ERROR_WORDS.rateLimited },
    });
    expect(h.applyGrouping).not.toHaveBeenCalled();
    h.applyGrouping.mockRejectedValueOnce(new Error('connection reset by peer at 10.0.0.1'));
    expect(await applyGroupingAction({})).toEqual({
      ok: false,
      error: { code: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
    });
  });
});

describe('previewGroupingAction', () => {
  it('answers the review with the organization and account it was read for (Cancel writes nothing)', async () => {
    h.previewGroup.mockResolvedValueOnce({ records: [], previewKey: 'k' });
    expect(await previewGroupingAction(['a', 'b'], 'g')).toEqual({
      ok: true,
      data: {
        review: { records: [], previewKey: 'k' },
        organizationId: 'org-1',
        actorUserId: 'user-1',
      },
    });
    expect(h.previewGroup).toHaveBeenCalledWith(['a', 'b'], 'g');
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping-preview:user-1', 60, 60_000);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a non-array or a bad target before the service', async () => {
    expect(await previewGroupingAction('a' as unknown as string[])).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(await previewGroupingAction(['a'], 7 as unknown as string)).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(h.previewGroup).not.toHaveBeenCalled();
  });
});
