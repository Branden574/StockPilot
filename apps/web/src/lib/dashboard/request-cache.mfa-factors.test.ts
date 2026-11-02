import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getMfaFactorsForRequest feeds the dashboard layout's AAL2 gate and
 * resolveMfaState's enrollment escalation. auth-js RESOLVES a GoTrue failure
 * as { data: { user: null }, error }; reading that as "no factors" let an
 * enrolled user past both at AAL1 under an 'optional' policy. It must throw
 * instead. And it says whose list it is (S43a, review round s43ar): the
 * session it reads can have refreshed into another account.
 */

const getUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn() }));

import { AuthSessionMissingError } from '@supabase/supabase-js';

import { SessionEndedError } from '@/lib/auth/session-ended';

import { getMfaFactorsForRequest } from './request-cache';

const MEMBER = '11111111-1111-4111-8111-111111111111';

describe('getMfaFactorsForRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the factors with the account GoTrue answered for', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: MEMBER, factors: [{ status: 'verified' }] } },
      error: null,
    });
    await expect(getMfaFactorsForRequest()).resolves.toEqual({
      userId: MEMBER,
      factors: [{ status: 'verified' }],
    });
  });

  it('an account with no factor lists none', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: MEMBER } }, error: null });
    await expect(getMfaFactorsForRequest()).resolves.toEqual({ userId: MEMBER, factors: [] });
  });

  it('a session that NO LONGER EXISTS is a SessionEndedError, not an unreadable list', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(getMfaFactorsForRequest()).rejects.toBeInstanceOf(SessionEndedError);
  });

  it('any OTHER failure is still an unreadable list (not mistaken for an ended session)', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: 'AuthApiError', message: 'boom', status: 500 },
    });
    const err = await getMfaFactorsForRequest().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionEndedError);
    expect((err as Error).message).toMatch(/getMfaFactorsForRequest/);
  });

  it('THROWS when the list cannot be read — never "no factors"', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'x' },
    });
    await expect(getMfaFactorsForRequest()).rejects.toThrow(/getMfaFactorsForRequest/);
  });
});
