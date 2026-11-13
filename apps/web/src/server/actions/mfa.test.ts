import { AuthSessionMissingError } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(async () => ({
    userId: 'user-1',
    email: 'u@example.test',
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

// The code checks read the account and its level from the session's verified
// claims, the client address from the request, and write refused-code rows
// through emitAuthAudit.
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionClaims: vi.fn(async () => ({
    userId: 'user-1',
    sessionId: 'session-1',
    aal: 'aal1',
    amr: [],
  })),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

// GoTrue's wrong-code answer, in the shape auth-js hands it back.
const GOTRUE_WRONG_CODE = {
  name: 'AuthApiError',
  status: 422,
  code: 'mfa_verification_failed',
  message: 'Invalid TOTP code entered',
};

const mfaStub = {
  challenge: vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null })),
  verify: vi.fn(async () => ({ data: null, error: null })),
  // f1 is the set-up just started: listed, not yet verified.
  listFactors: vi.fn(async () => ({
    data: { all: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }], totp: [] },
    error: null,
  })),
  unenroll: vi.fn(async () => ({ data: null, error: null })),
};

/**
 * GoTrue's answer for the session's own account (auth.getUser): its id and its
 * factor list. The code step reads the list from it, so it knows whose list it
 * is. Default: user-1 with f1, a verified authenticator.
 */
const account: {
  user: { id: string; factors: Array<{ id: string; status: string; factor_type: string }> } | null;
  error: unknown;
} = { user: null, error: null };

function accountWith(factors: Array<{ id: string; status: string }>, id = 'user-1') {
  account.user = { id, factors: factors.map((f) => ({ ...f, factor_type: 'totp' })) };
  account.error = null;
}

const authStub = {
  mfa: mfaStub,
  getUser: vi.fn(async () => ({ data: { user: account.user }, error: account.error })),
  signOut: vi.fn(async () => ({ error: null })),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: authStub })),
}));

import { readVerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { emitAuthAudit } from '@/server/services/auth-audit';

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
      'u@example.test',
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
      error: GOTRUE_WRONG_CODE,
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
    accountWith([{ id: 'f1', status: 'verified' }]);
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
      error: GOTRUE_WRONG_CODE,
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
    // Nor a code attempt from the budget.
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

/**
 * The sign-in code and the step-up check one budget of code attempts per
 * account and client address (shared with the reset's code step), answer in
 * plain words, and write an mfa.code_refused row only for a code GoTrue judged
 * wrong.
 */
describe('challengeFactorAction — code budget, words and rows', () => {
  const SUBMITTED = '246813';
  const REFUSED = 'That code is not valid. Check your authenticator app and try again.';
  const BUDGET_SPENT = 'Too many code attempts. Wait a few minutes and try again.';
  const GOTRUE_LIMITED = 'Too many code checks right now. Wait a minute and try again.';
  const NOT_CHECKED = 'Could not check your code just now. Try again.';
  const SESSION_ENDED = 'You were signed out on this device. Sign in again to continue.';
  const NOT_STARTED = 'Could not start the authenticator check. Please try again.';

  beforeEach(() => {
    vi.clearAllMocks();
    accountWith([{ id: 'f1', status: 'verified' }]);
    mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfaStub.verify.mockResolvedValue({ data: null, error: null });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
    vi.mocked(readVerifiedSessionClaims).mockResolvedValue({
      userId: 'user-1',
      sessionId: 'session-1',
      aal: 'aal1',
      amr: [],
      email: null,
    });
  });

  function verifyAnswers(error: unknown) {
    mfaStub.verify.mockResolvedValue({ data: null, error } as unknown as Awaited<
      ReturnType<typeof mfaStub.verify>
    >);
  }

  it('a refused code gets the plain words and one platform-only row, never the code', async () => {
    verifyAnswers(GOTRUE_WRONG_CODE);

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: REFUSED } });
    expect(emitAuthAudit).toHaveBeenCalledTimes(1);
    expect(emitAuthAudit).toHaveBeenCalledWith({
      event: 'mfa.code_refused',
      userId: 'user-1',
      organizationId: null,
      extra: { path: 'challenge', session_aal: 'aal1', gotrue_code: 'mfa_verification_failed' },
    });
    const row = JSON.stringify(vi.mocked(emitAuthAudit).mock.calls);
    expect(row).not.toContain(SUBMITTED);
    expect(row).not.toContain('f1');
  });

  it('a refusal during a step-up records the session as aal2', async () => {
    vi.mocked(readVerifiedSessionClaims).mockResolvedValue({
      userId: 'user-1',
      sessionId: 'session-1',
      aal: 'aal2',
      amr: [],
      email: null,
    });
    verifyAnswers(GOTRUE_WRONG_CODE);

    await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(emitAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ session_aal: 'aal2' }) }),
    );
  });

  it('a spent budget answers before GoTrue is asked, and writes nothing', async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 10, resetAt: 0 });

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'rate_limited', message: BUDGET_SPENT } });
    // Refused at this address: the account's ceiling at every address is not
    // asked, so the press does not spend it.
    expect(vi.mocked(checkRateLimit).mock.calls).toEqual([
      ['mfa-code:user-1:unknown', 10, 15 * 60_000, 'closed'],
    ]);
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(emitAuthAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['a sign-in code', 'aal1'],
    ['a step-up', 'aal2'],
  ] as const)(
    'keys the budget on the verified account (with and without the client address), never on the input: %s',
    async (_label, aal) => {
      vi.mocked(readVerifiedSessionClaims).mockResolvedValue({
        userId: 'verified-account',
        sessionId: 'session-1',
        aal,
        amr: [],
        email: null,
      });
      // The factor list is that account's own (the code step reads it first).
      accountWith([{ id: 'f1', status: 'verified' }], 'verified-account');

      await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

      // An allowed press counts once in each bucket, both before GoTrue is asked.
      expect(checkRateLimit).toHaveBeenCalledTimes(2);
      expect(checkRateLimit).toHaveBeenCalledWith(
        'mfa-code:verified-account:unknown',
        10,
        15 * 60_000,
        'closed',
      );
      expect(checkRateLimit).toHaveBeenCalledWith(
        'mfa-code-account:verified-account',
        20,
        60 * 60_000,
        'closed',
      );
      const [challengeOrder] = mfaStub.challenge.mock.invocationCallOrder;
      for (const limiterOrder of vi.mocked(checkRateLimit).mock.invocationCallOrder) {
        expect(limiterOrder).toBeLessThan(challengeOrder as number);
      }
    },
  );

  it.each([
    ['a sign-in code', 'aal1'],
    ['a step-up', 'aal2'],
  ] as const)(
    'the account’s ceiling across addresses, spent alone, refuses in the same words before GoTrue is asked: %s',
    async (_label, aal) => {
      vi.mocked(readVerifiedSessionClaims).mockResolvedValue({
        userId: 'user-1',
        sessionId: 'session-1',
        aal,
        amr: [],
        email: null,
      });
      vi.mocked(checkRateLimit).mockImplementation(async (key: string) => ({
        allowed: !key.startsWith('mfa-code-account:'),
        count: 20,
        resetAt: 0,
      }));

      const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

      expect(res).toEqual({ ok: false, error: { code: 'rate_limited', message: BUDGET_SPENT } });
      expect(mfaStub.challenge).not.toHaveBeenCalled();
      expect(mfaStub.verify).not.toHaveBeenCalled();
      expect(emitAuthAudit).not.toHaveBeenCalled();
    },
  );

  it('with no verified session, says the person was signed out and asks nothing', async () => {
    vi.mocked(readVerifiedSessionClaims).mockResolvedValue(null);

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mfaStub.challenge).not.toHaveBeenCalled();
  });

  it('a check that got no answer says so, and writes nothing', async () => {
    verifyAnswers({ name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' });

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_CHECKED } });
    expect(emitAuthAudit).not.toHaveBeenCalled();
  });

  it("GoTrue's own rate limit gets its own words and writes nothing", async () => {
    verifyAnswers({
      name: 'AuthApiError',
      status: 429,
      code: 'over_request_rate_limit',
      message: 'Request rate limit reached',
    });

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'rate_limited', message: GOTRUE_LIMITED } });
    expect(emitAuthAudit).not.toHaveBeenCalled();
  });

  it('a session that is gone says the person was signed out, and writes nothing', async () => {
    verifyAnswers({
      name: 'AuthSessionMissingError',
      status: 400,
      message: 'Auth session missing!',
    });

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expect(emitAuthAudit).not.toHaveBeenCalled();
  });

  it('an answer it does not know is reported (name, code and status only) and writes nothing', async () => {
    verifyAnswers({ name: 'AuthUnknownError', message: 'Unexpected token < in JSON' });

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_CHECKED } });
    expect(emitAuthAudit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), {
      tag: 'mfa.verify_unclassified',
      level: 'warning',
      extra: { name: 'AuthUnknownError', code: null, status: null },
    });
  });

  it("never passes GoTrue's words on to the person", async () => {
    verifyAnswers(GOTRUE_WRONG_CODE);

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(JSON.stringify(res)).not.toContain('Invalid TOTP code entered');
  });

  it('a challenge that failed gets the could-not-start words, not GoTrue’s', async () => {
    mfaStub.challenge.mockResolvedValue({
      data: null,
      error: {
        name: 'AuthApiError',
        status: 404,
        code: 'mfa_factor_not_found',
        message: 'factor not found',
      },
    } as unknown as Awaited<ReturnType<typeof mfaStub.challenge>>);

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(emitAuthAudit).not.toHaveBeenCalled();
  });
});

/**
 * The code step checks a code only against a VERIFIED authenticator of the
 * account the session verified as. The factor id comes from the page, so the
 * action reads the account's own factor list (GoTrue's user answer, which
 * names the account it is the list of) before any code attempt is spent. An
 * unfinished set-up is completed only by the set-up's own confirm step, which
 * asks for the account password (verifyEnrollmentAction).
 */
describe('challengeFactorAction — only a verified authenticator of the account', () => {
  const SUBMITTED = '246813';
  const NOT_STARTED = 'Could not start the authenticator check. Please try again.';
  const SESSION_ENDED = 'You were signed out on this device. Sign in again to continue.';

  beforeEach(() => {
    vi.clearAllMocks();
    accountWith([{ id: 'f1', status: 'verified' }]);
    mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfaStub.verify.mockResolvedValue({ data: null, error: null });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
    vi.mocked(readVerifiedSessionClaims).mockResolvedValue({
      userId: 'user-1',
      sessionId: 'session-1',
      aal: 'aal1',
      amr: [],
      email: null,
    });
  });

  function expectNothingSpent() {
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(emitAuthAudit).not.toHaveBeenCalled();
  }

  it('an unfinished set-up of the account is refused before any code attempt, and reported', async () => {
    accountWith([{ id: 'f1', status: 'unverified' }]);

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expectNothingSpent();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual(
      expect.objectContaining({ tag: 'actions.mfa.challenge', level: 'warning' }),
    );
    // Never the factor id or the code.
    const report = JSON.stringify(vi.mocked(reportError).mock.calls);
    expect(report).not.toContain('f1');
    expect(report).not.toContain(SUBMITTED);
  });

  it('an id the account’s list does not show (unknown, or another account’s) is refused the same way', async () => {
    accountWith([{ id: 'f-own', status: 'verified' }]);

    const res = await challengeFactorAction({ factorId: 'f-elsewhere', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expectNothingSpent();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'actions.mfa.challenge', level: 'warning' }),
    );
  });

  it('reads the account’s list once, before the code budget, and checks a verified authenticator as before', async () => {
    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: true, data: undefined });
    expect(authStub.getUser).toHaveBeenCalledTimes(1);
    const [listOrder] = authStub.getUser.mock.invocationCallOrder;
    for (const limiterOrder of vi.mocked(checkRateLimit).mock.invocationCallOrder) {
      expect(listOrder as number).toBeLessThan(limiterOrder);
    }
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: 'f1' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a list of another account than the verified one is no answer: this session is signed out and nothing is spent', async () => {
    accountWith([{ id: 'f1', status: 'verified' }], 'user-2');

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expect(authStub.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expectNothingSpent();
  });

  it('a list that cannot be read refuses with the could-not-start words, and nothing is spent', async () => {
    account.user = null;
    account.error = { name: 'AuthRetryableFetchError', status: 503, message: 'fetch failed' };

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expectNothingSpent();
  });

  it('a session gone at the list read says the person was signed out, and nothing is spent', async () => {
    account.user = null;
    account.error = new AuthSessionMissingError();

    const res = await challengeFactorAction({ factorId: 'f1', code: SUBMITTED });

    expect(res).toEqual({ ok: false, error: { code: 'unauthenticated', message: SESSION_ENDED } });
    expectNothingSpent();
  });
});

/**
 * verifyEnrollmentAction confirms the authenticator set-up that was just
 * started, and only that one: a factor id that the account's factor list does
 * not show as an open (unverified) set-up is refused before any code is
 * checked.
 */
describe('verifyEnrollmentAction — only the set-up just started', () => {
  const CONFIRM_VALUE = 'correct horse battery staple';
  const SETUP_CLOSED = 'This authenticator set-up is no longer open. Start again.';

  beforeEach(() => {
    vi.clearAllMocks();
    mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mfaStub.verify.mockResolvedValue({ data: null, error: null });
    mfaStub.listFactors.mockResolvedValue({
      data: {
        all: [
          { id: 'f-old', status: 'verified', factor_type: 'totp' },
          { id: 'f1', status: 'unverified', factor_type: 'totp' },
        ],
        totp: [{ id: 'f-old', status: 'verified', factor_type: 'totp' }],
      },
      error: null,
    } as unknown as Awaited<ReturnType<typeof mfaStub.listFactors>>);
    vi.mocked(verifyPasswordSideChannel).mockResolvedValue({ ok: true } as Awaited<
      ReturnType<typeof verifyPasswordSideChannel>
    >);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 1000,
    });
  });

  it('refuses an authenticator that is already verified, and checks no code', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f-old',
      code: '123456',
      password: CONFIRM_VALUE,
    });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: SETUP_CLOSED } });
    expect(mfaStub.challenge).not.toHaveBeenCalled();
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a factor id the list does not show, in the same words', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f-unknown',
      code: '123456',
      password: CONFIRM_VALUE,
    });

    expect(res).toEqual({ ok: false, error: { code: 'validation_error', message: SETUP_CLOSED } });
    expect(mfaStub.challenge).not.toHaveBeenCalled();
  });

  it('refuses when the factor list cannot be read', async () => {
    mfaStub.listFactors.mockResolvedValue({
      data: null,
      error: { name: 'AuthRetryableFetchError', status: 503, message: 'x' },
    } as unknown as Awaited<ReturnType<typeof mfaStub.listFactors>>);

    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: CONFIRM_VALUE,
    });

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not check your authenticator set-up. Try again.',
      },
    });
    expect(mfaStub.challenge).not.toHaveBeenCalled();
  });

  it('confirms the open set-up as before, after the password and before the challenge', async () => {
    const res = await verifyEnrollmentAction({
      factorId: 'f1',
      code: '123456',
      password: CONFIRM_VALUE,
    });

    expect(res.ok).toBe(true);
    expect(mfaStub.challenge).toHaveBeenCalledWith({ factorId: 'f1' });
    const [pwOrder] = vi.mocked(verifyPasswordSideChannel).mock.invocationCallOrder;
    const [listOrder] = mfaStub.listFactors.mock.invocationCallOrder;
    const [challengeOrder] = mfaStub.challenge.mock.invocationCallOrder;
    expect(pwOrder as number).toBeLessThan(listOrder as number);
    expect(listOrder as number).toBeLessThan(challengeOrder as number);
    // Its own budget, not the code budget of the sign-in and the step-up.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(
      'mfa-enroll-verify:user-1',
      5,
      15 * 60_000,
      'closed',
    );
  });
});
