import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * confirmExceptionCountAction (count differences R2, 0386) is a thin wrapper
 * over ExceptionOccurrencesService.confirmCount, the method the phone's
 * POST /api/v1/exceptions/[id]/confirm-count calls. Pinned here: the same
 * rate limit under the same key, the revalidated pages, app-authored reasons
 * passed through (with `retryable` for busy), and raw database text never.
 */

const { confirmCount, withContextMock, limiter } = vi.hoisted(() => ({
  confirmCount: vi.fn(),
  withContextMock: vi.fn(),
  limiter: { allowed: true, calls: [] as unknown[][] },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async (...args: unknown[]) => {
    limiter.calls.push(args);
    return { allowed: limiter.allowed, count: 1, resetAt: Date.now() + 5_000 };
  }),
}));
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    confirmCount = confirmCount;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';

import { confirmExceptionCountAction } from './exceptions';

const ID = '11111111-1111-4111-8111-111111111111';
const CC = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allowed = true;
  limiter.calls = [];
  withContextMock.mockResolvedValue({ organizationId: 'org-1', userId: 'u-1', role: 'staff', supabase: {} });
});

describe('confirmExceptionCountAction', () => {
  it('passes the count, the number and the note through, and revalidates the list and the occurrence', async () => {
    confirmCount.mockResolvedValue({ occurrence: { id: ID, reference: 'EX-000059' }, replay: false });
    await expect(
      confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2, note: 'counted twice' }),
    ).resolves.toEqual({ ok: true, replay: false, reference: 'EX-000059' });
    expect(confirmCount).toHaveBeenCalledWith(ID, { cycleCountId: CC, countedQuantity: 2, note: 'counted twice' });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/exceptions');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/exceptions/${ID}`);
  });

  it('is limited like the route, under the same key (the act bucket)', async () => {
    confirmCount.mockResolvedValue({ occurrence: { id: ID, reference: 'EX-000059' }, replay: false });
    await confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2 });
    expect(limiter.calls[0]).toEqual(['exceptions-act:u-1', 60, 60_000]);

    limiter.allowed = false;
    await expect(confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2 })).resolves.toEqual({
      error: { message: 'Too many requests. Wait a moment and try again.', reason: 'rate_limited', retryable: true },
    });
    expect(confirmCount).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed id without the service or the limiter', async () => {
    const res = await confirmExceptionCountAction('nope', { cycleCountId: CC, countedQuantity: 2 });
    expect(res).toEqual({ error: { message: 'That exception id is not valid.', reason: null } });
    expect(confirmCount).not.toHaveBeenCalled();
    expect(limiter.calls).toEqual([]);
  });

  it('a number that is not a number reaches the service as NaN (refused there), never as a guess', async () => {
    confirmCount.mockRejectedValue(
      new ServiceError('validation_error', 'The counted number is not valid.', { reason: 'invalid_argument' }),
    );
    const res = await confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: '2' as never });
    expect(confirmCount).toHaveBeenCalledWith(ID, { cycleCountId: CC, countedQuantity: Number.NaN, note: null });
    expect(res).toEqual({ error: { message: 'The counted number is not valid.', reason: 'invalid_argument' } });
  });

  it('passes an app-authored reason through, with retryable for busy', async () => {
    confirmCount.mockRejectedValue(
      new ServiceError('conflict', 'The stock on record changed after this count, so it can no longer be confirmed.', {
        reason: 'stock_moved',
      }),
    );
    await expect(confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2 })).resolves.toEqual({
      error: {
        message: 'The stock on record changed after this count, so it can no longer be confirmed.',
        reason: 'stock_moved',
      },
    });
    confirmCount.mockRejectedValue(
      new ServiceError('conflict', 'A check is running. Try again in a moment.', { reason: 'busy', retryable: true }),
    );
    await expect(confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2 })).resolves.toEqual({
      error: { message: 'A check is running. Try again in a moment.', reason: 'busy', retryable: true },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('never forwards raw database text', async () => {
    confirmCount.mockRejectedValue(new ServiceError('internal_error', 'relation "x" does not exist'));
    await expect(confirmExceptionCountAction(ID, { cycleCountId: CC, countedQuantity: 2 })).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});
