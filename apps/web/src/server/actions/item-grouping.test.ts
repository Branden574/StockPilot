import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS } from '@stockpilot/core';

/**
 * The web side of Ungroup: the review dialog's preview and Save. Both go
 * through ItemGroupingService (the phone's route uses the same one); Save is
 * rate limited in the same per-user bucket as the route, runs as the web
 * surface, and refreshes the Items and Books pages and every item page.
 */

const h = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  checkRateLimit: vi.fn(),
  splitSku: vi.fn(),
  previewSplit: vi.fn(),
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
    return { splitSku: h.splitSku, previewSplit: h.previewSplit };
  }),
}));

import { ServiceError } from '@/server/services/context';

import { previewUngroupAction, ungroupItemsAction } from './item-grouping';

beforeEach(() => {
  vi.clearAllMocks();
  h.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
});

describe('ungroupItemsAction', () => {
  it('splits as the web surface, then refreshes the lists and the item pages', async () => {
    h.splitSku.mockResolvedValueOnce({
      organizationId: 'org-1',
      replay: false,
      items: [{ id: 'a' }],
    });
    const r = await ungroupItemsAction({ some: 'body' });
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping:user-1', 30, 60_000);
    expect(h.splitSku).toHaveBeenCalledWith({ some: 'body' }, 'web');
    expect(r).toEqual({ ok: true, data: { replay: false, items: [{ id: 'a' }] } });
    expect(h.revalidatePath.mock.calls).toEqual([
      ['/dashboard/inventory'],
      ['/dashboard/books'],
      ['/dashboard/inventory/[id]', 'page'],
      ['/dashboard/books/[id]', 'page'],
    ]);
  });

  it('answers a refusal with its code, words and details, and refreshes nothing', async () => {
    h.splitSku.mockRejectedValueOnce(
      new ServiceError('conflict', GROUPING_ERROR_WORDS.itemChanged, {
        reason: 'item_changed',
        itemIds: ['a'],
      }),
    );
    const r = await ungroupItemsAction({});
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: GROUPING_ERROR_WORDS.itemChanged,
        details: { reason: 'item_changed', itemIds: ['a'] },
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
    expect(await ungroupItemsAction({})).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', message: GROUPING_ERROR_WORDS.rateLimited },
    });
    expect(h.splitSku).not.toHaveBeenCalled();
    h.splitSku.mockRejectedValueOnce(new Error('connection reset by peer at 10.0.0.1'));
    expect(await ungroupItemsAction({})).toEqual({
      ok: false,
      error: { code: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
    });
  });
});

describe('previewUngroupAction', () => {
  it('answers the service preview (it writes nothing, so Cancel writes nothing)', async () => {
    h.previewSplit.mockResolvedValueOnce({ candidates: [{ id: 'a' }] });
    expect(await previewUngroupAction(['a'])).toEqual({
      ok: true,
      data: { candidates: [{ id: 'a' }], organizationId: 'org-1', actorUserId: 'user-1' },
    });
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping-preview:user-1', 60, 60_000);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a non-array before the service', async () => {
    expect(await previewUngroupAction('a' as unknown as string[])).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(h.previewSplit).not.toHaveBeenCalled();
  });
});
