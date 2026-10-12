import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS } from '@stockpilot/core';

/**
 * Ungroup anything on the web (owner 2026-10-12): the review and the Save go
 * through UngroupSelectedService (the phone's routes use the same one); Save
 * is rate limited in the grouping bucket, runs as the web surface, refreshes
 * the lists and item pages when a record changed, and Product groups when a
 * record left its size family. Never a raw message to the browser.
 */

const h = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  checkRateLimit: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
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
vi.mock('@/server/services/item-grouping', () => ({ ItemGroupingService: vi.fn() }));
vi.mock('@/server/services/ungroup-selected', () => ({
  UngroupSelectedService: vi.fn(function () {
    return { preview: h.preview, apply: h.apply };
  }),
}));

import { ServiceError } from '@/server/services/context';

import { previewUngroupSelectedAction, ungroupSelectedAction } from './item-grouping';

const part = (kind: string, changed: string[]) => ({
  kind,
  status: 'applied',
  changedItemIds: changed,
  notChangedItemIds: [],
  message: null,
  reason: null,
  retryable: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
});

describe('ungroupSelectedAction', () => {
  it('applies as the web surface and refreshes the lists, the item pages and Product groups after an unlink', async () => {
    h.apply.mockResolvedValueOnce({
      organizationId: 'org-1',
      outcome: { complete: true, parts: [part('remove', ['a']), part('unlink', ['b'])] },
    });
    const r = await ungroupSelectedAction({ some: 'body' });
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping:user-1', 30, 60_000);
    expect(h.apply).toHaveBeenCalledWith({ some: 'body' }, 'web');
    expect(r).toEqual({
      ok: true,
      data: { outcome: { complete: true, parts: [part('remove', ['a']), part('unlink', ['b'])] } },
    });
    expect(h.revalidatePath.mock.calls).toEqual([
      ['/dashboard/inventory'],
      ['/dashboard/books'],
      ['/dashboard/inventory/[id]', 'page'],
      ['/dashboard/books/[id]', 'page'],
      ['/dashboard/product-groups'],
    ]);
  });

  it('refreshes nothing when nothing changed, and Product groups only after an unlink', async () => {
    h.apply.mockResolvedValueOnce({
      organizationId: 'org-1',
      outcome: { complete: false, parts: [{ ...part('split', []), status: 'refused' }] },
    });
    await ungroupSelectedAction({});
    expect(h.revalidatePath).not.toHaveBeenCalled();
    h.apply.mockResolvedValueOnce({
      organizationId: 'org-1',
      outcome: { complete: true, parts: [part('split', ['a'])] },
    });
    await ungroupSelectedAction({});
    expect(h.revalidatePath.mock.calls.map((c) => c[0])).not.toContain('/dashboard/product-groups');
  });

  it('a refusal keeps its code, words and details; anything else is the generic sentence', async () => {
    h.apply.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Taking a record out of a size family needs permission.', {
        reason: 'family_permission',
      }),
    );
    expect(await ungroupSelectedAction({})).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Taking a record out of a size family needs permission.',
        details: { reason: 'family_permission' },
      },
    });
    h.apply.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const r = await ungroupSelectedAction({});
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
    });
  });

  it('is refused when the rate limit is spent, before the service runs', async () => {
    h.checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 31, resetAt: Date.now() });
    expect(await ungroupSelectedAction({})).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
    });
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe('previewUngroupSelectedAction', () => {
  it('reads the review and names the organization and account it answered for', async () => {
    h.preview.mockResolvedValueOnce({
      review: { records: [] },
      candidates: [],
      canUnlinkFamilies: true,
      previewKey: 'k',
    });
    const r = await previewUngroupSelectedAction(['a']);
    expect(h.checkRateLimit).toHaveBeenCalledWith('item-grouping-preview:user-1', 60, 60_000);
    expect(r).toEqual({
      ok: true,
      data: {
        review: { records: [] },
        candidates: [],
        canUnlinkFamilies: true,
        previewKey: 'k',
        organizationId: 'org-1',
        actorUserId: 'user-1',
      },
    });
  });

  it('refuses ids that are not strings before any read', async () => {
    expect(await previewUngroupSelectedAction([1 as never])).toMatchObject({
      ok: false,
      error: { code: 'validation_error' },
    });
    expect(h.preview).not.toHaveBeenCalled();
  });
});
