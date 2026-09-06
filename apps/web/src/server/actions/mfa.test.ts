import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@e.com',
    fullName: null,
    avatarUrl: null,
    defaultOrganizationId: 'org-1',
  })),
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'admin',
  })),
}));

// Password re-confirm is MANDATORY on enrollment confirm — mock the verifier
// (default: ok) so the tests below can flip it per-case.
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));

vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));

const mfaStub = {
  challenge: vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null })),
  verify: vi.fn(async () => ({ data: null, error: null })),
  listFactors: vi.fn(async () => ({ data: { all: [], totp: [] }, error: null })),
  unenroll: vi.fn(async () => ({ data: null, error: null })),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { mfa: mfaStub } })),
}));

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { checkRateLimit } from '@/lib/rate-limit';

import { verifyEnrollmentAction } from './mfa';

describe('verifyEnrollmentAction — password re-confirm is mandatory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfaStub.verify.mockResolvedValue({ data: null, error: null });
    vi.mocked(verifyPasswordSideChannel).mockResolvedValue({ ok: true } as Awaited<
      ReturnType<typeof verifyPasswordSideChannel>
    >);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
  });

  // SP-066: the password used to be `.optional()`, so a caller that simply
  // omitted the field skipped the rate limit AND the password check and still
  // got the factor verified — a stolen AAL1 cookie could enroll an
  // attacker-owned authenticator and lock the real owner out.
  it('refuses to verify a factor when no password is supplied', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
    } as unknown as { factorId: string; code: string; password: string });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    // The factor must never be challenged/verified without a proven password.
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
  });

  it('refuses to verify a factor when the password is wrong', async () => {
    vi.mocked(verifyPasswordSideChannel).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Incorrect password.',
    } as Awaited<ReturnType<typeof verifyPasswordSideChannel>>);

    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'wrong',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
  });

  it('refuses when the enrollment-confirm rate limit is exhausted', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 6,
      resetAt: Date.now() + 1000,
    });

    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(verifyPasswordSideChannel).not.toHaveBeenCalled();
    expect(mfaStub.challenge).not.toHaveBeenCalled();
  });

  it('verifies the factor once the password checks out', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    expect(res.ok).toBe(true);
    expect(verifyPasswordSideChannel).toHaveBeenCalledWith(
      'u@e.com',
      'correct horse battery staple',
    );
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: 'f1' });
    expect(mfaStub.verify).toHaveBeenCalledWith({
      factorId: 'f1',
      challengeId: 'challenge-1',
      code: '123456',
    });
  });
});
