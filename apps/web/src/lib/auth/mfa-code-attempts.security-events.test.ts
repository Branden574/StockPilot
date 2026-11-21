import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The authenticator code checks' security events (part 1 of the security
 * tools): a code GoTrue judged wrong for the account the press was checked
 * for is wrong_code; a spent code budget, in either bucket, is
 * code_checks_paused. Both are recorded in the account's organization, looked
 * up after the response (server/security/account-events.ts). A limiter that
 * could not count, a verified code, an answer that judged nothing and a
 * session that turned out to be another account's record nothing.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  requestHeaders: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  checkRateLimit: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: vi.fn(async () => h.requestHeaders) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => h.checkRateLimit(...args),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/security/account-events', () => ({ recordAccountCodeBlocked: vi.fn() }));

import { recordAccountCodeBlocked } from '@/server/security/account-events';
import { verifiedSessionAuth } from '@/test/verified-session-stub';

import { allowMfaCodeAttempt, checkMfaCode } from './mfa-code-attempts';

const allowed = { allowed: true, count: 1, resetAt: 0 };
const refused = { allowed: false, count: 11, resetAt: 0 };
const couldNotCount = { allowed: false, count: 10, resetAt: 0, failed: true as const };

function client(verifyError: unknown, holder: { sub: string } = { sub: 'u1' }) {
  return {
    auth: {
      mfa: {
        challenge: vi.fn(async () => ({ data: { id: 'challenge-1' }, error: null })),
        verify: vi.fn(async () => ({ data: null, error: verifyError })),
      },
      signOut: vi.fn(async () => ({ error: null })),
      ...verifiedSessionAuth(() => ({ sub: holder.sub, aal: 'aal1', read: 'answer' })),
    },
  } as never;
}

const press = { userId: 'u1', factorId: 'f1', code: '135790', path: 'challenge' as const };
const recorded = () => vi.mocked(recordAccountCodeBlocked).mock.calls;

beforeEach(() => {
  h.checkRateLimit.mockReset();
  h.checkRateLimit.mockResolvedValue(allowed);
});

describe('a spent code budget is code_checks_paused', () => {
  it('the address bucket refuses', async () => {
    h.checkRateLimit.mockResolvedValueOnce(refused);
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
    expect(recorded()).toEqual([['code_checks_paused', 'u1', h.requestHeaders]]);
  });

  it('the account bucket refuses', async () => {
    h.checkRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(refused);
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
    expect(recorded()).toEqual([['code_checks_paused', 'u1', h.requestHeaders]]);
  });

  it('a limiter that could not count records nothing (and still refuses)', async () => {
    h.checkRateLimit.mockResolvedValueOnce(couldNotCount);
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
    h.checkRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(couldNotCount);
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(false);
    expect(recorded()).toEqual([]);
  });

  it('an allowed press records nothing', async () => {
    await expect(allowMfaCodeAttempt('u1')).resolves.toBe(true);
    expect(recorded()).toEqual([]);
  });

  it('through checkMfaCode: budget_spent, recorded once', async () => {
    h.checkRateLimit.mockResolvedValueOnce(refused);
    await expect(checkMfaCode(client(null), press)).resolves.toEqual({ kind: 'budget_spent' });
    expect(recorded().map(([r]) => r)).toEqual(['code_checks_paused']);
  });
});

describe('a code judged wrong is wrong_code', () => {
  it('GoTrue refused the code for this account', async () => {
    const check = await checkMfaCode(
      client({ code: 'mfa_verification_failed', status: 422, name: 'AuthApiError' }),
      press,
    );
    expect(check).toEqual({ kind: 'verify_failed', outcome: 'refused' });
    expect(recorded()).toEqual([['wrong_code', 'u1', h.requestHeaders]]);
  });

  it('the reset’s code step too', async () => {
    await checkMfaCode(client({ code: 'mfa_verification_failed', status: 422 }), {
      ...press,
      path: 'password_reset',
    });
    expect(recorded().map(([r]) => r)).toEqual(['wrong_code']);
  });

  it('a verified code, an answer that judged nothing, or another account’s session: nothing', async () => {
    await checkMfaCode(client(null), press);
    await checkMfaCode(client({ name: 'AuthRetryableFetchError' }), press);
    await checkMfaCode(client({ code: 'over_request_rate_limit', status: 429 }), press);
    await checkMfaCode(client({ code: 'mfa_verification_failed', status: 422 }, { sub: 'u2' }), press);
    expect(recorded()).toEqual([]);
  });
});
