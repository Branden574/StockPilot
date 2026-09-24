import { beforeEach, describe, expect, it, vi } from 'vitest';

import { redirect } from 'next/navigation';

/**
 * Security invariant (S6-A, listed in scripts/security-test.sh).
 *
 * The rental server actions answer the web toast. An error that is not a
 * ServiceError used to go back as its own `message` (whatever the thrower
 * wrote: a PostgREST string, a network error); it now gets a fixed sentence.
 * An internal ServiceError already carries the generic message (S13). A
 * redirect from the auth context still redirects.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const withContextMock = vi.fn();
vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return { ...actual, withContext: () => withContextMock() };
});

const svcMethods = {
  create: vi.fn(),
  markReturned: vi.fn(),
  cancel: vi.fn(),
};
vi.mock('@/server/services/rentals', () => ({
  RentalsService: vi.fn(function () {
    return svcMethods;
  }),
}));

import { ServiceError } from '@/server/services/context';

import { cancelRentalAction, createRentalAction, markRentalReturnedAction } from './rentals';

const RENTAL_ID = '33333333-3333-4333-8333-333333333333';
const createInput = {
  warehouseId: '11111111-1111-4111-8111-111111111111',
  borrowerName: 'Jane Doe',
  expectedReturnAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  lines: [{ itemId: '22222222-2222-4222-8222-222222222222', quantity: 1 }],
};

const RAW = 'permission denied for table stock_reservations';

const actions = [
  ['createRentalAction', () => createRentalAction(createInput), 'create'],
  ['markRentalReturnedAction', () => markRentalReturnedAction({ id: RENTAL_ID }), 'markReturned'],
  ['cancelRentalAction', () => cancelRentalAction({ id: RENTAL_ID, reason: 'Wrong items' }), 'cancel'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withContextMock.mockResolvedValue({ organizationId: 'org-1', userId: 'u-1' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('rental actions never return a raw error message', () => {
  // Mutation caught: returning `e.message` for a non-ServiceError again.
  it.each(actions)('%s: a thrown Error gets the fixed sentence', async (_name, run, method) => {
    svcMethods[method].mockRejectedValueOnce(new Error(RAW));
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'internal_error',
        message: 'Something went wrong. Please try again.',
      });
    }
  });

  it.each(actions)('%s: an internal ServiceError carries only the generic message', async (_name, run, method) => {
    svcMethods[method].mockRejectedValueOnce(new ServiceError('internal_error', RAW));
    const result = await run();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).not.toContain('stock_reservations');
    }
  });

  it('keeps an app-authored sentence (a conflict) verbatim', async () => {
    const sentence =
      'Someone else is checking out or approving these items right now. Try again in a moment.';
    svcMethods.create.mockRejectedValueOnce(new ServiceError('conflict', sentence));
    const result = await createRentalAction(createInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ code: 'conflict', message: sentence });
  });

  // Mutation caught: dropping unstable_rethrow, which turns a signed-out
  // session's redirect into an error toast.
  it('rethrows a redirect from the auth context', async () => {
    let redirectError: unknown;
    try {
      redirect('/signin');
    } catch (e) {
      redirectError = e;
    }
    withContextMock.mockRejectedValueOnce(redirectError);
    await expect(markRentalReturnedAction({ id: RENTAL_ID })).rejects.toBe(redirectError);
  });
});
