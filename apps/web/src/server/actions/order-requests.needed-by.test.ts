import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NEEDED_BY_FAILED_COPY,
  NEEDED_BY_NOT_PENDING_COPY,
  NEEDED_BY_SUGGESTION_REASON,
  type NeededByRevisionOutcome,
} from '@stockpilot/core';

import { ServiceError } from '@/server/services/context';

/**
 * F2-4 server actions for the needed-by date. The service is the authority
 * (order-requests.revise-needed-by.test.ts); these pin what each action hands
 * it, what it answers (a refusal's `details` intact, so the dialog can load a
 * date someone else saved, and a fault in core's words), and what it
 * revalidates.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
  revalidateInventoryListForOrg: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const reviseNeededBy = vi.fn();
vi.mock('@/server/services/order-requests', () => ({
  OrderRequestsService: { forCurrentUser: vi.fn(async () => ({ reviseNeededBy })) },
}));

import { revalidatePath } from 'next/cache';

import { reportError } from '@/lib/error-reporter';

import { reviseOrderNeededByAction, setOrderNeededByAction } from './order-requests';

const ORDER = '11111111-1111-4111-8111-111111111111';
const SEEN = '2026-10-01T21:00:00.123456+00:00';

function outcome(over: Partial<NeededByRevisionOutcome> = {}): NeededByRevisionOutcome {
  return {
    changed: true,
    previous: '2026-10-01T21:00:00.123Z',
    neededBy: '2026-10-03T21:00:00.000Z',
    eventId: 'ev-1',
    eventUpdated: true,
    status: 'approved',
    schedule: 'moved',
    timeZone: 'America/Los_Angeles',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reviseNeededBy.mockReset();
  reviseNeededBy.mockResolvedValue(outcome());
});

describe('reviseOrderNeededByAction', () => {
  it('hands the service the wall clock, the value seen exactly as read and the reason; answers the outcome', async () => {
    const res = await reviseOrderNeededByAction({
      id: ORDER,
      neededByLocal: '2026-10-03T14:00',
      expectedNeededBy: SEEN,
      reason: 'The school moved the day',
    });
    expect(reviseNeededBy).toHaveBeenCalledWith({
      id: ORDER,
      neededByLocal: '2026-10-03T14:00',
      expectedNeededBy: SEEN,
      reason: 'The school moved the day',
    });
    expect(res).toEqual({ ok: true, data: outcome() });
  });

  it('revalidates the order, the orders list and the Schedule when the entry moved', async () => {
    await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: null, reason: 'r' });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0]).sort()).toEqual(
      ['/dashboard/orders', `/dashboard/orders/${ORDER}`, '/dashboard/schedule'].sort(),
    );
  });

  it('an equal value changed nothing, so nothing is revalidated', async () => {
    reviseNeededBy.mockResolvedValueOnce(outcome({ changed: false, schedule: 'unchanged', eventUpdated: false }));
    await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-01T14:00', expectedNeededBy: SEEN, reason: 'r' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a stale edit keeps its details (reason and the current value) so the dialog can load it', async () => {
    reviseNeededBy.mockRejectedValueOnce(
      new ServiceError('conflict', 'Someone changed this date to Sat, Oct 5, 2:00 PM while you were editing.', {
        reason: 'needed_by_changed',
        current: '2026-10-05T21:00:00.000Z',
      }),
    );
    const res = await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: SEEN, reason: 'r' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: 'Someone changed this date to Sat, Oct 5, 2:00 PM while you were editing.',
        details: { reason: 'needed_by_changed', current: '2026-10-05T21:00:00.000Z' },
      },
    });
  });

  it('the MFA step-up refusal keeps its details (useStepUp reads them)', async () => {
    reviseNeededBy.mockRejectedValueOnce(new ServiceError('forbidden', 'Step up', { reason: 'aal2_required' }));
    const res = await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: SEEN, reason: 'r' });
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden', details: { reason: 'aal2_required' } } });
  });

  it('a fault is core\'s sentence, never the raw text; an unexpected throw is reported', async () => {
    reviseNeededBy.mockRejectedValueOnce(new ServiceError('internal_error', 'revise_order_needed_by failed: XX000: boom'));
    expect(
      await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: SEEN, reason: 'r' }),
    ).toEqual({ ok: false, error: { code: 'internal_error', message: NEEDED_BY_FAILED_COPY, details: { reason: 'failed' } } });
    expect(reportError).not.toHaveBeenCalled(); // the service reported it

    reviseNeededBy.mockRejectedValueOnce(new Error('socket hang up'));
    expect(
      await reviseOrderNeededByAction({ id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: SEEN, reason: 'r' }),
    ).toMatchObject({ ok: false, error: { code: 'internal_error', message: NEEDED_BY_FAILED_COPY } });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed call before the service', async () => {
    for (const bad of [
      { id: 'nope', neededByLocal: '2026-10-03T14:00', expectedNeededBy: null, reason: 'r' },
      { id: ORDER, neededByLocal: '', expectedNeededBy: null, reason: 'r' },
      { id: ORDER, neededByLocal: '2026-10-03T14:00', expectedNeededBy: 'yesterday', reason: 'r' },
      { id: ORDER, neededByLocal: '2026-10-03T14:00', reason: 'r' },
    ]) {
      const res = await reviseOrderNeededByAction(bad as never);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(reviseNeededBy).not.toHaveBeenCalled();
  });
});

describe('setOrderNeededByAction (the AI suggestion\'s Apply) goes through the same service', () => {
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();

  it('the instant as given, expected null (an older tab sends none), the fixed reason, pending-only', async () => {
    const res = await setOrderNeededByAction({ id: ORDER, neededBy: future });
    expect(reviseNeededBy).toHaveBeenCalledWith({
      id: ORDER,
      neededByAt: future,
      expectedNeededBy: null,
      reason: NEEDED_BY_SUGGESTION_REASON,
      onlyWhenPending: true,
    });
    expect(NEEDED_BY_SUGGESTION_REASON).toBe("Set from the requester's note");
    expect(res).toEqual({ ok: true, data: undefined });
  });

  it('passes the value the screen saw when it sends one', async () => {
    await setOrderNeededByAction({ id: ORDER, neededBy: future, expectedNeededBy: SEEN });
    expect(reviseNeededBy.mock.calls[0]![0]).toMatchObject({ expectedNeededBy: SEEN });
  });

  it('an order no longer pending is refused in core\'s words', async () => {
    reviseNeededBy.mockRejectedValueOnce(
      new ServiceError('conflict', NEEDED_BY_NOT_PENDING_COPY, { reason: 'not_pending' }),
    );
    expect(await setOrderNeededByAction({ id: ORDER, neededBy: future })).toEqual({
      ok: false,
      error: { code: 'conflict', message: NEEDED_BY_NOT_PENDING_COPY, details: { reason: 'not_pending' } },
    });
  });

  it('keeps refusing a past time before the service', async () => {
    const res = await setOrderNeededByAction({ id: ORDER, neededBy: '2020-01-01T00:00:00Z' });
    expect(res).toMatchObject({ ok: false, error: { code: 'validation_error', message: 'Needed-by must be in the future.' } });
    expect(reviseNeededBy).not.toHaveBeenCalled();
  });
});
