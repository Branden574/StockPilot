import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUTHENTICATOR SCREENS NEVER ANSWER GOTRUE'S OR THE DATABASE'S TEXT (S31).
 *
 * A Server Action's result reaches the browser as it is. The set-up, the
 * sign-in code, removing an authenticator and the organization's MFA policy
 * answered GoTrue's message (it can carry factor and challenge identifiers)
 * or Postgres text, and every refused set-up code read as "not valid" whatever
 * GoTrue said. Now the words follow how GoTrue answered
 * (classifyMfaCodeError): a code it judged wrong, its own rate limit, a gone
 * session, no answer; a failure nobody expected says the fixed sentence and
 * is reported.
 */

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

const mfaStub = {
  challenge: vi.fn(),
  verify: vi.fn(),
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
};
const orgPolicy = {
  read: { data: { mfa_policy: 'optional' } as unknown, error: null as unknown },
  update: { data: { id: 'org-1' } as unknown, error: null as unknown },
};
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    let op = 'select';
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.update = () => {
      op = 'update';
      return q;
    };
    q.eq = () => q;
    q.maybeSingle = async () => (op === 'update' ? orgPolicy.update : orgPolicy.read);
    return { from: () => q, auth: { mfa: mfaStub } };
  }),
}));

import { reportError } from '@/lib/error-reporter';

import {
  challengeFactorAction,
  enrollFactorAction,
  setOrgMfaPolicyAction,
  unenrollFactorAction,
  verifyEnrollmentAction,
} from './mfa';

const REFUSED = 'That code is not valid. Check your authenticator app and try again.';
const GOTRUE_LIMITED = 'Too many code checks right now. Wait a minute and try again.';
const NOT_CHECKED = 'Could not check your code just now. Try again.';
const SESSION_ENDED = 'You were signed out on this device. Sign in again to continue.';
const NOT_STARTED = 'Could not start the authenticator check. Please try again.';
const UNEXPECTED = 'Something went wrong. Please try again.';

/** GoTrue's answers, in the shapes auth-js hands them back. */
const WRONG_CODE = {
  name: 'AuthApiError',
  status: 422,
  code: 'mfa_verification_failed',
  message: 'Invalid TOTP code entered',
};
const GOTRUE_429 = {
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
const UNKNOWN = {
  name: 'AuthApiError',
  status: 422,
  code: 'mfa_challenge_expired',
  message: 'Challenge 7c1e2a90-0000-4000-8000-000000000001 has expired',
};

const SETUP = { factorId: 'f1', code: '123456', password: 'the-account-password' };

beforeEach(() => {
  vi.clearAllMocks();
  mfaStub.challenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
  mfaStub.verify.mockResolvedValue({ data: null, error: null });
  mfaStub.listFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  mfaStub.unenroll.mockResolvedValue({ data: null, error: null });
  orgPolicy.read = { data: { mfa_policy: 'optional' }, error: null };
  orgPolicy.update = { data: { id: 'org-1' }, error: null };
});

describe.each([
  [
    'the set-up code (verifyEnrollmentAction)',
    () => verifyEnrollmentAction(SETUP),
    'actions.mfa.verify_enrollment',
  ],
  [
    'the sign-in and step-up code (challengeFactorAction)',
    () => challengeFactorAction({ factorId: 'f1', code: '123456' }),
    'actions.mfa.challenge',
  ],
] as const)("%s says how GoTrue answered, never GoTrue's text", (_label, act, tag) => {
  function verifyAnswers(error: unknown) {
    mfaStub.verify.mockResolvedValue({ data: null, error });
  }

  it('a code GoTrue judged wrong: not valid, unreported', async () => {
    verifyAnswers(WRONG_CODE);
    expect(await act()).toEqual({
      ok: false,
      error: { code: 'validation_error', message: REFUSED },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("GoTrue's own rate limit: wait a minute", async () => {
    verifyAnswers(GOTRUE_429);
    expect(await act()).toEqual({
      ok: false,
      error: { code: 'rate_limited', message: GOTRUE_LIMITED },
    });
  });

  it('no answer: could not check the code, never "not valid"', async () => {
    verifyAnswers(NO_ANSWER);
    expect(await act()).toEqual({
      ok: false,
      error: { code: 'internal_error', message: NOT_CHECKED },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a gone session: signed out on this device', async () => {
    verifyAnswers(SESSION_GONE);
    expect(await act()).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: SESSION_ENDED },
    });
  });

  it('an answer it does not know: could not check, reported as a warning, never the identifiers', async () => {
    verifyAnswers(UNKNOWN);
    const res = await act();
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_CHECKED } });
    expect(JSON.stringify(res)).not.toContain('7c1e2a90');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag,
      level: 'warning',
      extra: { code: 'mfa_challenge_expired' },
    });
  });

  it('a challenge that could not start: its own sentence, reported, and no verify', async () => {
    mfaStub.challenge.mockResolvedValue({ data: null, error: UNKNOWN });
    const res = await act();
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: NOT_STARTED } });
    expect(JSON.stringify(res)).not.toContain('7c1e2a90');
    expect(mfaStub.verify).not.toHaveBeenCalled();
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag,
      extra: { code: 'mfa_challenge_expired' },
    });
  });

  it('a challenge refused for a gone session says so, unreported', async () => {
    mfaStub.challenge.mockResolvedValue({ data: null, error: SESSION_GONE });
    expect(await act()).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: SESSION_ENDED },
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('enroll, remove and the policy say the fixed sentence (S31)', () => {
  it('an enroll GoTrue refused: the fixed sentence, with its code in the report', async () => {
    mfaStub.enroll.mockResolvedValue({
      data: null,
      error: {
        name: 'AuthApiError',
        status: 422,
        code: 'mfa_factor_name_conflict',
        message: 'A factor with the friendly name "StockPilot" for this user already exists',
      },
    });
    const res = await enrollFactorAction();
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: UNEXPECTED } });
    expect(JSON.stringify(res)).not.toContain('friendly name');
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({
      tag: 'actions.mfa.enroll',
      extra: { code: 'mfa_factor_name_conflict' },
    });
  });

  it("a removal GoTrue refused: the fixed sentence, never GoTrue's text", async () => {
    mfaStub.unenroll.mockResolvedValue({
      data: null,
      error: {
        name: 'AuthApiError',
        status: 404,
        code: 'mfa_factor_not_found',
        message: 'Factor f1 not found',
      },
    });
    const res = await unenrollFactorAction({ factorId: 'f1' });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: UNEXPECTED } });
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    // The report carries GoTrue's text and code (lib/error-text.ts, C21).
    expect((reported as Error).message).toBe('Factor f1 not found (code mfa_factor_not_found)');
    expect(context).toEqual({
      tag: 'actions.mfa.unenroll',
      organizationId: 'org-1',
      extra: { code: 'mfa_factor_not_found' },
    });
  });

  it('a policy write the database refused: the fixed sentence, the text only in the report', async () => {
    orgPolicy.update = {
      data: null,
      error: { message: 'new row violates row-level security policy for table "organizations"' },
    };
    const res = await setOrgMfaPolicyAction({ policy: 'all_required' });
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message: UNEXPECTED } });
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toContain('row-level security');
    expect(context).toEqual({ tag: 'actions.mfa.policy', organizationId: 'org-1' });
  });
});
