import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The authenticator set-up's security event (part 1 of the security tools).
 * verifyEnrollmentAction sends the first code of a new authenticator to the
 * sign-in service. A code the service judged wrong is wrong_setup_code, in
 * the account's organization (looked up after the response,
 * server/security/account-events.ts): not wrong_code, since nothing that
 * protects the account is being guessed. So every code our own server sends
 * that the service refuses has a record, and the reader of the service's own
 * log (server/security/auth-logs.ts) can compare the two counts.
 *
 * Its limit, a gone session, no answer, an answer that judged nothing and a
 * code that was right record nothing; what the member reads is unchanged.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  requestHeaders: new Headers({ 'x-forwarded-for': '203.0.113.7' }) as Headers | null,
  recordAccountCodeBlocked: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    if (!h.requestHeaders) throw new Error('`headers` was called outside a request scope');
    return h.requestHeaders;
  }),
}));
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
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({})),
  assertCurrentAal2: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/verify-password', () => ({
  verifyPasswordSideChannel: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/verified-claims', () => ({
  readVerifiedSessionClaims: vi.fn(async () => ({
    userId: 'user-1',
    sessionId: 'session-1',
    aal: 'aal1',
    amr: [],
  })),
  readVerifiedSessionClaimsOf: vi.fn(async (_client: unknown, userId: string) => ({
    userId,
    sessionId: 'session-1',
    aal: 'aal1',
    amr: [],
  })),
}));
vi.mock('@/server/services/auth-audit', () => ({ emitAuthAudit: vi.fn(async () => {}) }));
vi.mock('@/server/security/account-events', () => ({
  recordAccountCodeBlocked: (...a: unknown[]) => h.recordAccountCodeBlocked(...a),
}));

const mfaStub = { challenge: vi.fn(), verify: vi.fn(), listFactors: vi.fn() };
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      mfa: mfaStub,
      getUser: async () => ({
        data: { user: { id: 'user-1', factors: [{ id: 'f1', status: 'unverified' }] } },
        error: null,
      }),
    },
  })),
}));

import { verifyPasswordSideChannel } from '@/lib/auth/verify-password';

import { verifyEnrollmentAction } from './mfa';

const REFUSED = 'That code is not valid. Check your authenticator app and try again.';

/** The sign-in service's answers, in the shapes its client library hands them back. */
const WRONG_CODE = {
  name: 'AuthApiError',
  status: 422,
  code: 'mfa_verification_failed',
  message: 'Invalid TOTP code entered',
};
const LIMITED = {
  name: 'AuthApiError',
  status: 429,
  code: 'over_request_rate_limit',
  message: 'Request rate limit reached',
};
const NO_ANSWER = { name: 'AuthRetryableFetchError', status: 503, message: 'fetch failed' };
const SESSION_GONE = {
  name: 'AuthSessionMissingError',
  status: 400,
  message: 'Auth session missing!',
};
const NOT_JUDGED = {
  name: 'AuthApiError',
  status: 422,
  code: 'mfa_challenge_expired',
  message: 'expired',
};

// A dull value under a neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
const SETUP_VALUE = 'the-account-value';
const SETUP = { factorId: 'f1', code: '123456', password: SETUP_VALUE };

beforeEach(() => {
  h.requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
  h.recordAccountCodeBlocked.mockReset();
  vi.mocked(verifyPasswordSideChannel).mockResolvedValue({ ok: true });
  mfaStub.challenge.mockReset();
  mfaStub.verify.mockReset();
  mfaStub.listFactors.mockReset();
  mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
  mfaStub.verify.mockResolvedValue({ data: null, error: null });
  mfaStub.listFactors.mockResolvedValue({
    data: { all: [{ id: 'f1', status: 'unverified', factor_type: 'totp' }], totp: [] },
    error: null,
  });
});

describe('a refused set-up code is recorded', () => {
  it('a code the service judged wrong: wrong_setup_code, for the account, with the request headers', async () => {
    mfaStub.verify.mockResolvedValue({ data: null, error: WRONG_CODE });
    const result = await verifyEnrollmentAction(SETUP);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'validation_error', message: REFUSED }),
    });
    expect(h.recordAccountCodeBlocked.mock.calls).toEqual([
      ['wrong_setup_code', 'user-1', h.requestHeaders],
    ]);
  });

  it.each([
    ["the service's own limit", LIMITED],
    ['no answer', NO_ANSWER],
    ['a gone session', SESSION_GONE],
    ['an answer that judged no code', NOT_JUDGED],
  ])('%s: nothing is recorded', async (_what, error) => {
    mfaStub.verify.mockResolvedValue({ data: null, error });
    const result = await verifyEnrollmentAction(SETUP);
    expect(result.ok).toBe(false);
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
  });

  it('a code that was right records nothing', async () => {
    expect(await verifyEnrollmentAction(SETUP)).toEqual({ ok: true, data: undefined });
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
  });

  it('a challenge that could not start, and a wrong password before it, record nothing here', async () => {
    mfaStub.challenge.mockResolvedValue({ data: null, error: WRONG_CODE });
    expect((await verifyEnrollmentAction(SETUP)).ok).toBe(false);
    vi.mocked(verifyPasswordSideChannel).mockResolvedValue({
      ok: false,
      reason: 'invalid_password',
      message: 'Password is incorrect.',
    });
    expect((await verifyEnrollmentAction(SETUP)).ok).toBe(false);
    // The password check records its own refusal (lib/auth/verify-password).
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
  });
});

describe('recording changes nothing the member sees', () => {
  it('outside a request there are no headers: recorded without them, the answer the same', async () => {
    h.requestHeaders = null;
    mfaStub.verify.mockResolvedValue({ data: null, error: WRONG_CODE });
    const result = await verifyEnrollmentAction(SETUP);
    expect(result).toMatchObject({ ok: false, error: { message: REFUSED } });
    expect(h.recordAccountCodeBlocked.mock.calls).toEqual([['wrong_setup_code', 'user-1', null]]);
  });

  it('a recorder that throws never reaches the member: the answer is the same', async () => {
    h.recordAccountCodeBlocked.mockImplementation(() => {
      throw new Error('recorder down');
    });
    mfaStub.verify.mockResolvedValue({ data: null, error: WRONG_CODE });
    const result = await verifyEnrollmentAction(SETUP);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'validation_error', message: REFUSED }),
    });
  });

  it('the password check is given the account, so its own refusal is recorded for it', async () => {
    await verifyEnrollmentAction(SETUP);
    expect(verifyPasswordSideChannel).toHaveBeenCalledWith('u@example.test', SETUP_VALUE, 'user-1');
  });
});
