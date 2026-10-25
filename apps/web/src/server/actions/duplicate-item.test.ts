import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NEW_RACK_REQUIRES_CONFIRMATION, newRackConfirmationDetail } from '@stockpilot/core';

/**
 * Security invariant (S13): the Duplicate action answers an internal failure
 * with fixed words and no details. A raw exception's text (database or network
 * detail) stays in the server log; this action used to return it.
 *
 * Every other refusal keeps its words and its details. Since 2026-10-24 the
 * server asks "Create new rack 1-B?" before a copy lands on a rack that does
 * not exist, and the question rides the refusal's `details`. This action used
 * to drop them, so the dialog could only have shown a sentence it had no way
 * to answer.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(),
}));

const svc = vi.hoisted(() => ({ duplicateItem: vi.fn() }));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => svc) },
}));

import { ServiceError } from '@/server/services/context';

import { duplicateItemAction } from './duplicate-item';

const ORIGINAL_ID = '33333333-3333-4333-8333-333333333333';
const INPUT = {
  originalId: ORIGINAL_ID,
  itemType: 'product' as const,
  rackNumber: '1',
  rackRow: 'B',
  quantity: 4,
};

beforeEach(() => vi.clearAllMocks());

describe('duplicateItemAction', () => {
  it('hands the new-rack question to the dialog whole', async () => {
    const detail = newRackConfirmationDetail({
      label: '1-B',
      warehouseName: 'DC4',
      quantity: 4,
      existingLabels: ['17-B', '18-B'],
    })!;
    svc.duplicateItem.mockRejectedValueOnce(
      new ServiceError('conflict', detail.message, { ...detail }),
    );

    const res = await duplicateItemAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: { code: 'conflict', message: detail.message, details: detail },
    });
    expect(detail.reason).toBe(NEW_RACK_REQUIRES_CONFIRMATION);
  });

  it('passes the yes on to the service, and leaves it out when it was not given', async () => {
    svc.duplicateItem.mockResolvedValue({ id: 'dup-1', placementFailed: null });

    await expect(duplicateItemAction({ ...INPUT, confirmNewRack: true })).resolves.toEqual({
      ok: true,
      data: { id: 'dup-1' },
    });
    expect(svc.duplicateItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmNewRack: true }),
    );

    await duplicateItemAction(INPUT);
    expect(svc.duplicateItem.mock.calls[1]?.[0]).not.toHaveProperty('confirmNewRack');
  });

  // 2026-10-25: a copy whose stock did not reach its rack was reported only to
  // Sentry, and the dialog said "Duplicated" over stock left at the original's
  // site. The action hands the outcome to the dialog, as createItemAction does.
  it('hands the dialog a copy whose stock did not reach its rack, and nothing when it did', async () => {
    svc.duplicateItem.mockResolvedValueOnce({
      id: 'dup-1',
      placementFailed: { rackName: '1-B', count: 1 },
    });
    await expect(duplicateItemAction({ ...INPUT, confirmNewRack: true })).resolves.toEqual({
      ok: true,
      data: { id: 'dup-1', placementFailed: { rackName: '1-B', count: 1 } },
    });

    svc.duplicateItem.mockResolvedValueOnce({ id: 'dup-2', placementFailed: null });
    await expect(duplicateItemAction(INPUT)).resolves.toEqual({
      ok: true,
      data: { id: 'dup-2' },
    });
  });

  it("never forwards an internal error's detail", async () => {
    svc.duplicateItem.mockRejectedValueOnce(
      new ServiceError('internal_error', 'relation inventory_items violates policy', {
        hint: 'raw',
      }),
    );

    const res = await duplicateItemAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'An internal error occurred. Please try again.' },
    });
  });

  it('says an unexpected failure as a plain sentence, never in its own words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.duplicateItem.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6543'));

    const res = await duplicateItemAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
    spy.mockRestore();
  });
});
