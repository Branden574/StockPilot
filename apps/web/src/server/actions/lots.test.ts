import { describe, expect, it, vi } from 'vitest';

const recordLotPicks = vi.fn();
vi.mock('@/server/services/lots', () => ({
  LotsService: { forCurrentUser: vi.fn(async () => ({ recordLotPicks })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { recordLotPicksAction } from './lots';

describe('recordLotPicksAction', () => {
  it('rejects invalid input (no picks)', async () => {
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1', picks: [],
    });
    expect(res.ok).toBe(false);
  });

  it('delegates to the service and returns ok on success', async () => {
    recordLotPicks.mockResolvedValueOnce(undefined);
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1',
      picks: [{ lotNumber: 'A', qty: 2, expirationDate: '2026-07-01' }],
    });
    expect(res.ok).toBe(true);
    expect(recordLotPicks).toHaveBeenCalledOnce();
  });

  it('maps a service ServiceError to err', async () => {
    recordLotPicks.mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { name: 'ServiceError', code: 'validation_error' }),
    );
    const res = await recordLotPicksAction({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'i1',
      picks: [{ lotNumber: 'A', qty: 1, expirationDate: '2000-01-01' }],
    });
    expect(res.ok).toBe(false);
  });
});
