import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exceptions server actions are thin wrappers over the service the phone's
 * routes use. Pinned here: a bad id never reaches the service, app-authored
 * reasons pass through, and raw database text never does.
 */

const { act, requestCheck } = vi.hoisted(() => ({ act: vi.fn(), requestCheck: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    act = act;
    requestCheck = requestCheck;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({ organizationId: 'org-1' })),
}));

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';

import { actOnExceptionAction, requestExceptionCheckAction } from './exceptions';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => vi.clearAllMocks());

describe('actOnExceptionAction', () => {
  it('passes the action through and revalidates the list and the occurrence', async () => {
    act.mockResolvedValue({ id: ID });
    await expect(
      actOnExceptionAction(ID, { action: 'note', note: 'checking rack', clientEventId: 'ce-1' }),
    ).resolves.toEqual({ ok: true });
    expect(act).toHaveBeenCalledWith(ID, { action: 'note', note: 'checking rack', clientEventId: 'ce-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/exceptions');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/exceptions/${ID}`);
  });

  it('refuses a malformed id without calling the service', async () => {
    const res = await actOnExceptionAction('nope', { action: 'acknowledge' });
    expect(res).toEqual({ error: { message: 'That exception id is not valid.', reason: null } });
    expect(act).not.toHaveBeenCalled();
  });

  it('forwards an app-authored reason (a resolved occurrence)', async () => {
    act.mockRejectedValue(
      new ServiceError('conflict', 'This exception has already been resolved.', { reason: 'occurrence_resolved' }),
    );
    await expect(actOnExceptionAction(ID, { action: 'acknowledge' })).resolves.toEqual({
      error: { message: 'This exception has already been resolved.', reason: 'occurrence_resolved' },
    });
  });

  it('never forwards raw database text', async () => {
    act.mockRejectedValue(new ServiceError('internal_error', 'relation "x" violates policy', { code: '42P01' }));
    await expect(actOnExceptionAction(ID, { action: 'acknowledge' })).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});

describe('requestExceptionCheckAction', () => {
  it('returns the scheduling answer at once', async () => {
    requestCheck.mockResolvedValue({ scheduled: true, lastSyncedAt: null, retryAfterSeconds: 0 });
    await expect(requestExceptionCheckAction()).resolves.toEqual({
      ok: true,
      scheduled: true,
      lastSyncedAt: null,
      retryAfterSeconds: 0,
    });
  });

  it('a staff member is refused with the service message', async () => {
    requestCheck.mockRejectedValue(new ServiceError('forbidden', 'Only a manager can run a check now.'));
    await expect(requestExceptionCheckAction()).resolves.toEqual({
      error: { message: 'Only a manager can run a check now.', reason: null },
    });
  });
});
