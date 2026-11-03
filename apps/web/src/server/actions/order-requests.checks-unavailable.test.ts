import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountStatusUnavailableError } from '@/lib/auth/account-status';
import { PermissionsUnavailableError } from '@/lib/auth/effective-permissions';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { withContext } from '@/server/services/context';

import { ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY } from '@stockpilot/core';

/**
 * S31 review: every order action gets its context through
 * OrderRequestsService.forCurrentUser() -> withContext(), which throws
 * PermissionsUnavailableError when the permission read fails and
 * AccountStatusUnavailableError when the account status read fails. The
 * order actions' toResult answered those with the generic sentence and an
 * error-level report, where every action on actionErrorResult answers each
 * with its own sentence and reports it as a warning. Same answer here now.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { cancelOrderRequestAction } from './order-requests';

const ORDER = '44444444-4444-4444-8444-444444444444';

beforeEach(() => vi.clearAllMocks());

describe('an order action whose permission or account check could not run', () => {
  it.each([
    [
      'permissions',
      new PermissionsUnavailableError(),
      'Your permissions could not be checked. Please try again.',
    ],
    [
      'account status',
      new AccountStatusUnavailableError(),
      'Account status could not be verified. Please try again.',
    ],
  ] as const)(
    '%s: answers its own sentence, reported as a warning',
    async (_name, thrown, sentence) => {
      vi.mocked(withContext).mockRejectedValue(thrown);
      const res = await cancelOrderRequestAction({ id: ORDER, reason: null });
      expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: sentence } });
      expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reportError)).toHaveBeenCalledWith(thrown, {
        tag: 'actions.order_requests',
        level: 'warning',
      });
    },
  );

  it("answers a warehouse access read that failed as the retryable conflict, never the refusal's text", async () => {
    const thrown = new ForbiddenError('User does not have write access to warehouse wh-1.', {
      accessUnreadable: true,
    });
    vi.mocked(withContext).mockRejectedValue(thrown);
    const res = await cancelOrderRequestAction({ id: ORDER, reason: null });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
        details: { reason: 'failed', retryable: true },
      },
    });
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(thrown, {
      tag: 'actions.order_requests',
      level: 'warning',
    });
  });

  it('still answers an unexpected failure with the generic sentence, reported at error level', async () => {
    const thrown = new Error('relation "order_requests" does not exist');
    vi.mocked(withContext).mockRejectedValue(thrown);
    const res = await cancelOrderRequestAction({ id: ORDER, reason: null });
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    });
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(thrown, { tag: 'actions.order_requests' });
  });
});
