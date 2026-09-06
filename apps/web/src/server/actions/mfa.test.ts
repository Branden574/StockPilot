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
import { audit } from '@/server/services/audit';

import { challengeFactorAction, verifyEnrollmentAction } from './mfa';

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

/**
 * SP-051 — two gaps the block above leaves open, both of them properties whose
 * ONLY enforcement is a single argument or line in mfa.ts.
 *
 * (1) The enrollment-confirm rate limit must run in `'closed'` mode.
 *     rate-limit.ts fails OPEN by default, so dropping that argument turns any
 *     Supabase blip into unlimited TOTP guesses against a known factor id —
 *     and the existing "rate limit is exhausted" test still passes, because it
 *     stubs the RESULT rather than asserting how the gate was called.
 * (2) A verified enrollment must be audited, and a REJECTED code must not be.
 *     An audit row for a factor that never became verified is a false record
 *     of an account's auth posture.
 */
describe('verifyEnrollmentAction — gate shape and audit', () => {
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

  it('keys the confirm gate on the user and runs it in closed mode', async () => {
    await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    expect(checkRateLimit).toHaveBeenCalledWith(
      'mfa-enroll-verify:user-1',
      5,
      15 * 60_000,
      'closed',
    );
  });

  it('proves the password BEFORE the factor is challenged', async () => {
    await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    // Ordering is a property in its own right: a password check that ran after
    // the challenge would already have spent the factor's challenge window,
    // and the sibling "wrong password" test would still pass if the two calls
    // were simply swapped and the challenge result discarded.
    const [pwOrder] = vi.mocked(verifyPasswordSideChannel).mock.invocationCallOrder;
    const [challengeOrder] = mfaStub.challenge.mock.invocationCallOrder;
    expect(pwOrder).toBeDefined();
    expect(challengeOrder).toBeDefined();
    expect(pwOrder as number).toBeLessThan(challengeOrder as number);
  });

  it('audits the enrollment once the factor is verified', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    expect(res.ok).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mfa.enrolled', entityId: 'user-1' }),
    );
  });

  it('does not audit an enrollment whose code was rejected', async () => {
    mfaStub.verify.mockResolvedValue({
      data: null,
      error: { message: 'Invalid TOTP code entered' },
    } as unknown as Awaited<ReturnType<typeof mfaStub.verify>>);

    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: 'correct horse battery staple',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(audit).not.toHaveBeenCalled();
  });
});

/**
 * SP-051 — challengeFactorAction is the action that actually mints AAL2 at
 * sign-in, and it had no test at all. Three properties matter:
 *   - the code is verified against the challenge THIS call created (a stale or
 *     wrong challengeId makes every correct code look invalid);
 *   - a failed challenge must NOT be followed by a verify attempt;
 *   - a rejected code is a `validation_error`, a broken challenge is an
 *     `internal_error`. /signin/mfa renders those two very differently, and
 *     collapsing them tells a user with a clock-skewed authenticator that the
 *     system is broken (or the reverse).
 */
describe('challengeFactorAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfaStub.verify.mockResolvedValue({ data: null, error: null });
  });

  it('verifies the code against the challenge it just created', async () => {
    const res = await challengeFactorAction({ factorId: 'f1', code: '123456' });

    expect(res.ok).toBe(true);
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: 'f1' });
    expect(mfaStub.verify).toHaveBeenCalledWith({
      factorId: 'f1',
      challengeId: 'challenge-1',
      code: '123456',
    });
  });

  it('never attempts a verify when the challenge itself failed', async () => {
    mfaStub.challenge.mockResolvedValue({
      data: null,
      error: { message: 'factor not found' },
    } as unknown as Awaited<ReturnType<typeof mfaStub.challenge>>);

    const res = await challengeFactorAction({ factorId: 'f1', code: '123456' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(mfaStub.verify).not.toHaveBeenCalled();
  });

  it('reports a rejected code as a validation error, not an internal one', async () => {
    mfaStub.verify.mockResolvedValue({
      data: null,
      error: { message: 'Invalid TOTP code entered' },
    } as unknown as Awaited<ReturnType<typeof mfaStub.verify>>);

    const res = await challengeFactorAction({ factorId: 'f1', code: '123456' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
  });

  it('treats a challenge that reports an error as failed even when it returns data', async () => {
    // The guard is `chErr || !challenge`, not `!challenge`. GoTrue can hand
    // back a challenge row alongside an error (expired/mismatched factor);
    // verifying against it burns the attempt and reports "invalid code" for a
    // code that was fine.
    mfaStub.challenge.mockResolvedValue({
      data: { id: 'challenge-1' },
      error: { message: 'challenge expired' },
    } as unknown as Awaited<ReturnType<typeof mfaStub.challenge>>);

    const res = await challengeFactorAction({ factorId: 'f1', code: '123456' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(mfaStub.verify).not.toHaveBeenCalled();
  });

  it('rejects a malformed code before spending a challenge', async () => {
    const res = await challengeFactorAction({ factorId: 'f1', code: '12ab' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(mfaStub.challenge).not.toHaveBeenCalled();
  });
});
