import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: a refused sign-in is recorded after the response, so
 * its timing tells nothing about the email, and a refusal that is not a
 * wrong password is recorded with no organization.
 *
 * signInAction's security events (part 1 of the security tools): a refusal by
 * the email or the address limiter is sign_in_paused, credentials GoTrue
 * judged wrong are wrong_password, the Auth server's own limit is
 * auth_server_paused, and a refusal with the status of a wrong password that
 * is not one (a disabled account, an unconfirmed email) is
 * sign_in_refused_other, recorded with no organization. A limiter that could
 * not count, an answer that judged nothing and a sign-in that worked record
 * nothing.
 *
 * The organization comes from the typed email, looked up AFTER the response
 * (server/security/account-events.ts): the action returns before anything is
 * read about the email, so a refusal takes the same time for an account's
 * email and for one that is not.
 *
 * Addresses are from the documentation ranges (RFC 5737); emails are
 * example.com.
 */

const signInWithPassword = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  after: vi.fn(),
  useRealHelper: false,
  profileReads: [] as unknown[][],
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-vercel-ip-country': 'NL',
        'user-agent': 'vitest-agent',
      }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn(), delete: () => {} })),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/server', () => ({ after: h.after }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/auth/account-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-status')>()),
  noteDisabledAccountBlocked: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastToChannel: vi.fn() }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://sb.example.com',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => h.checkRateLimit(...args),
}));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: ORG, role: 'staff' })),
}));
// The email lookup: user_profiles by email (a thenable chain).
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'limit']) {
        chain[m] = (...args: unknown[]) => {
          h.profileReads.push([table, m, ...args]);
          return chain;
        };
      }
      chain.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: 'user-1' }], error: null }).then(ok);
      return chain;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signInWithPassword, mfa: { getAuthenticatorAssuranceLevel } } }),
}));
vi.mock('@/server/security/account-events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/security/account-events')>();
  return {
    ...real,
    recordSignInBlocked: vi.fn((...args: Parameters<typeof real.recordSignInBlocked>) =>
      h.useRealHelper ? real.recordSignInBlocked(...args) : undefined,
    ),
  };
});

const ORG = '5eed0000-0001-4000-8000-000000000001';

import { recordSignInBlocked } from '@/server/security/account-events';
import { recordSecurityEvent } from '@/server/security/events';

import { signInAction } from './auth';

const allowed = { allowed: true, count: 1, resetAt: 0 };
const refused = { allowed: false, count: 6, resetAt: 0 };
const couldNotCount = { allowed: false, count: 5, resetAt: 0, failed: true as const };
const input = { email: 'Ada@Example.com', password: 'not-the-password', rememberMe: false };

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  h.useRealHelper = false;
  h.profileReads = [];
  h.after.mockReset();
  h.checkRateLimit.mockReset();
  h.checkRateLimit.mockResolvedValue(allowed);
  signInWithPassword.mockReset();
  getAuthenticatorAssuranceLevel.mockReset();
  getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function recorded(): Array<[string, string, Headers]> {
  return vi.mocked(recordSignInBlocked).mock.calls as unknown as Array<[string, string, Headers]>;
}

describe('signInAction records its refusals', () => {
  it('the email limiter refuses: sign_in_paused, with the lower-cased email and the request headers', async () => {
    h.checkRateLimit.mockResolvedValueOnce(refused);
    const result = await signInAction(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(recorded()).toHaveLength(1);
    const [reason, email, headers] = recorded()[0]!;
    expect(reason).toBe('sign_in_paused');
    expect(email).toBe('ada@example.com');
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.1');
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('the address limiter refuses: sign_in_paused', async () => {
    h.checkRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(refused);
    await signInAction(input);
    expect(recorded().map(([r]) => r)).toEqual(['sign_in_paused']);
  });

  it('a limiter that could not count records nothing (it refuses all the same)', async () => {
    h.checkRateLimit.mockResolvedValueOnce(couldNotCount);
    expect(await signInAction(input)).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    h.checkRateLimit.mockResolvedValueOnce(allowed).mockResolvedValueOnce(couldNotCount);
    expect(await signInAction(input)).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(recorded()).toEqual([]);
  });

  it('credentials GoTrue judged wrong: wrong_password', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' },
    });
    expect(await signInAction(input)).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(recorded().map(([r, e]) => [r, e])).toEqual([['wrong_password', 'ada@example.com']]);
  });

  it('the Auth server’s own limit: auth_server_paused', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 429, code: 'over_request_rate_limit', message: 'slow down' },
    });
    await signInAction(input);
    expect(recorded().map(([r]) => r)).toEqual(['auth_server_paused']);
  });

  it('a disabled account: sign_in_refused_other (recorded with no organization), the answer unchanged', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 400, code: 'user_banned', message: 'User is banned' },
    });
    expect(await signInAction(input)).toMatchObject({ ok: false, error: { code: 'account_disabled' } });
    expect(recorded().map(([r]) => r)).toEqual(['sign_in_refused_other']);
  });

  it.each([
    ['an unconfirmed email', 'email_not_confirmed'],
    ['a code this does not know', 'something_new'],
    ['no code at all', undefined],
  ])(
    'the service refused with its 400 for a reason that is not a wrong password (%s): sign_in_refused_other',
    async (_what, code) => {
      signInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { status: 400, code, message: 'refused' },
      });
      expect(await signInAction(input)).toMatchObject({
        ok: false,
        error: { code: 'unauthenticated', message: 'Invalid email or password' },
      });
      expect(recorded().map(([r]) => r)).toEqual(['sign_in_refused_other']);
    },
  );

  it('an answer that judged no credentials (an outage) records nothing', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 500, message: 'upstream' },
    });
    await signInAction(input);
    expect(recorded()).toEqual([]);
  });

  it('a sign-in that worked records nothing', async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    expect(await signInAction(input)).toMatchObject({ ok: true });
    expect(recorded()).toEqual([]);
  });
});

describe('a sign-in refused for another reason is recorded with no organization', () => {
  it.each([['user_banned'], ['email_not_confirmed']])(
    '%s: nothing about the email is ever read, and the event names no organization',
    async (code) => {
      h.useRealHelper = true;
      signInWithPassword.mockResolvedValue({
        data: { user: null },
        error: { status: 400, code, message: 'refused' },
      });
      await signInAction(input);
      expect(recordSecurityEvent).not.toHaveBeenCalled();
      for (const [task] of h.after.mock.calls) await (task as () => Promise<unknown>)();
      expect(h.profileReads).toEqual([]);
      expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
      expect(recordSecurityEvent).toHaveBeenCalledWith(
        {
          category: 'password_guessing',
          outcome: 'blocked',
          reason: 'sign_in_refused_other',
          source: 'web',
          organizationId: null,
        },
        expect.any(Headers),
      );
    },
  );
});

describe('the organization is looked up after the response', () => {
  it('the action returns before the email is looked up; afterwards the event names the organization', async () => {
    h.useRealHelper = true;
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' },
    });
    const result = await signInAction(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    // Answered: nothing about the email has been read or recorded yet.
    expect(h.profileReads).toEqual([]);
    expect(recordSecurityEvent).not.toHaveBeenCalled();

    // The platform runs the after() work once the response is sent.
    for (const [task] of h.after.mock.calls) await (task as () => Promise<unknown>)();
    expect(h.profileReads).toContainEqual(['user_profiles', 'eq', 'email', 'ada@example.com']);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      {
        category: 'password_guessing',
        outcome: 'blocked',
        reason: 'wrong_password',
        source: 'web',
        organizationId: ORG,
      },
      expect.any(Headers),
    );
  });
});
