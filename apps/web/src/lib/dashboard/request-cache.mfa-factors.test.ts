import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getMfaFactorsForRequest feeds the dashboard layout's AAL2 gate and
 * resolveMfaState's enrollment escalation. auth-js RESOLVES a GoTrue failure
 * as { data: null, error }; reading that as "no factors" let an enrolled user
 * past both at AAL1 under an 'optional' policy. It must throw instead.
 */

const listFactors = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { mfa: { listFactors } } })),
}));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn() }));

import { AuthSessionMissingError } from '@supabase/supabase-js';

import { SessionEndedError } from '@/lib/auth/session-ended';

import { getMfaFactorsForRequest } from './request-cache';

describe('getMfaFactorsForRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the factors when GoTrue answers', async () => {
    listFactors.mockResolvedValueOnce({ data: { all: [{ status: 'verified' }] }, error: null });
    await expect(getMfaFactorsForRequest()).resolves.toEqual([{ status: 'verified' }]);
  });

  it('a session that NO LONGER EXISTS is a SessionEndedError, not an unreadable list', async () => {
    listFactors.mockResolvedValueOnce({ data: null, error: new AuthSessionMissingError() });
    await expect(getMfaFactorsForRequest()).rejects.toBeInstanceOf(SessionEndedError);
  });

  it('any OTHER failure is still an unreadable list (not mistaken for an ended session)', async () => {
    listFactors.mockResolvedValueOnce({ data: null, error: { name: 'AuthApiError', message: 'boom', status: 500 } });
    const err = await getMfaFactorsForRequest().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SessionEndedError);
    expect((err as Error).message).toMatch(/getMfaFactorsForRequest/);
  });

  it('THROWS when the list cannot be read — never "no factors"', async () => {
    listFactors.mockResolvedValueOnce({ data: null, error: { name: 'AuthRetryableFetchError', message: 'x' } });
    await expect(getMfaFactorsForRequest()).rejects.toThrow(/getMfaFactorsForRequest/);
  });
});
