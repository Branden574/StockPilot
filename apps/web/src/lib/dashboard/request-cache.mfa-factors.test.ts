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

import { getMfaFactorsForRequest } from './request-cache';

describe('getMfaFactorsForRequest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the factors when GoTrue answers', async () => {
    listFactors.mockResolvedValueOnce({ data: { all: [{ status: 'verified' }] }, error: null });
    await expect(getMfaFactorsForRequest()).resolves.toEqual([{ status: 'verified' }]);
  });

  it('THROWS when the list cannot be read — never "no factors"', async () => {
    listFactors.mockResolvedValueOnce({ data: null, error: { name: 'AuthRetryableFetchError', message: 'x' } });
    await expect(getMfaFactorsForRequest()).rejects.toThrow(/getMfaFactorsForRequest/);
  });
});
