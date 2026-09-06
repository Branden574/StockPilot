import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SP-051 — signInAction is the unauthenticated front door, and until this file
 * existed the ONLY test that named it read auth.ts as TEXT and asserted that
 * `if (isBannedUserAuthError(` appeared before `'Invalid email or password'`.
 * A source-order grep is satisfied by a branch sitting in dead or unreachable
 * code, so three single-enforcement properties shipped unpinned:
 *
 *   1. the dual brute-force gate — 5/min/email and 30/min/ip — and, more
 *      importantly, that BOTH run in `'closed'` mode. rate-limit.ts fails OPEN
 *      by default; flipping these two calls to the default would leave the
 *      login form unthrottled for the whole duration of any Supabase blip, and
 *      would ship completely green.
 *   2. the `user_banned` -> `account_disabled` mapping. If it regressed, a
 *      disabled user would be told "Invalid email or password" and sent to
 *      reset a password that is perfectly fine.
 *   3. the AAL decision. An enrolled user must be routed to /signin/mfa on an
 *      AAL1 session. This is not the last line of defence — (dashboard)/
 *      layout.tsx re-checks AAL and redirects — but a regression here is a
 *      confusing bounce loop that nothing else would catch.
 *
 * These are BEHAVIOURAL: they call the action and assert on what it returns and
 * what it called. The source-grep describe that used to live in
 * auth.account-disabled.test.ts was deleted when this file landed.
 */

const signInWithPassword = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const cookieSet = vi.fn();

const { checkRateLimit, auditInsert, noteLoginDevice, noteDisabledAccountBlocked } = vi.hoisted(
  () => ({
    checkRateLimit: vi.fn(),
    auditInsert: vi.fn(),
    noteLoginDevice: vi.fn(),
    noteDisabledAccountBlocked: vi.fn(),
  }),
);

// A real header bag: getClientIp takes the FIRST entry of x-forwarded-for, and
// that value becomes the second rate-limit key. Returning an empty Headers (as
// the sibling auth tests do) would collapse the ip key to the literal
// 'unknown' and hide a regression in the extraction itself.
vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'user-agent': 'vitest-agent',
      }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: cookieSet, delete: () => {} })),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
// `after` must stay mocked or noteLoginDevice runs for real on the happy path.
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/login-device', () => ({
  noteLoginDevice: (...args: unknown[]) => noteLoginDevice(...args),
}));
vi.mock('@/lib/auth/account-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account-status')>()),
  noteDisabledAccountBlocked: (...args: unknown[]) => noteDisabledAccountBlocked(...args),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastToChannel: vi.fn() }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://sb.example.com',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));

// The admin client serves two callers inside signInAction: the audit_logs
// insert (captured, and asserted on) and resolveDefaultOrgAndRole's
// user_profiles / organization_members lookups (nulls are fine — both columns
// are nullable on audit_logs, which is the whole point of that helper).
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'audit_logs') {
        return { insert: (row: unknown) => auditInsert(row) };
      }
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'not', 'limit', 'order']) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = async () => ({ data: null, error: null });
      return chain;
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithPassword,
      mfa: { getAuthenticatorAssuranceLevel },
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword: vi.fn() } }),
}));

import { ACCOUNT_DISABLED_MESSAGE } from '@stockpilot/core';

import { signInAction } from './auth';

const INPUT = { email: 'User@Example.com', password: 'Passw0rd!', rememberMe: true };

/** The metadata blob the action writes onto the audit row. */
function auditMetadata(callIndex = 0): Record<string, unknown> {
  const row = auditInsert.mock.calls[callIndex]?.[0] as
    | { metadata?: Record<string, unknown> }
    | undefined;
  return row?.metadata ?? {};
}

describe('signInAction — brute-force gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    });
    auditInsert.mockResolvedValue({ error: null });
  });

  it('keys the email gate on the NORMALISED email and runs it in closed mode', async () => {
    await signInAction(INPUT);

    // 'closed' is the load-bearing argument: rate-limit.ts defaults to failing
    // OPEN, so dropping this argument silently converts a DB blip into an
    // unlimited-attempt window on the login form.
    expect(checkRateLimit).toHaveBeenNthCalledWith(1, 'signin:user@example.com', 5, 60_000, 'closed');
  });

  it('adds a per-IP gate from the first x-forwarded-for hop, also closed', async () => {
    await signInAction(INPUT);

    expect(checkRateLimit).toHaveBeenNthCalledWith(2, 'signin-ip:203.0.113.7', 30, 60_000, 'closed');
  });

  it('refuses without ever touching GoTrue when the email gate is spent', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 5, resetAt: Date.now() });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
    // The whole point of the gate: the credential attempt must not be made.
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('refuses when the IP gate is spent, after the email gate allowed', async () => {
    checkRateLimit
      .mockResolvedValueOnce({ allowed: true, count: 1, resetAt: Date.now() })
      .mockResolvedValueOnce({ allowed: false, count: 30, resetAt: Date.now() });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('signInAction — disabled account vs bad credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    });
    auditInsert.mockResolvedValue({ error: null });
  });

  it('maps GoTrue user_banned to account_disabled with the shared copy', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: 'user_banned', message: 'User is banned', status: 400 },
    });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('account_disabled');
      // Owner-approved wording, imported — not retyped here or in auth.ts.
      expect(res.error.message).toBe(ACCOUNT_DISABLED_MESSAGE);
    }
    // Forensics: the ban is audited through the existing sign-in-failure event
    // with its own reason, so a disable is distinguishable from a typo.
    expect(auditMetadata().reason).toBe('account_disabled');
    expect(noteDisabledAccountBlocked).toHaveBeenCalledWith('login');
  });

  it('still collapses a genuine credential mismatch to the generic sentence', async () => {
    // The mirror of the case above: the account-status sentence must NEVER
    // appear for a wrong password, or the form becomes a status oracle.
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 },
    });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unauthenticated');
      expect(res.error.message).toBe('Invalid email or password');
    }
    expect(auditMetadata().reason).toBe('invalid_credentials');
  });

  it('separates Supabase own 429 throttle from a credential mismatch', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { status: 429, code: 'over_request_rate_limit', message: 'too many' },
    });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
    expect(auditMetadata().reason).toBe('supabase_rate_limited');
  });
});

describe('signInAction — AAL routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
    signInWithPassword.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    auditInsert.mockResolvedValue({ error: null });
  });

  it('routes an enrolled user to the TOTP step, and records mfa_required', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.next).toBe('/signin/mfa');
    expect(auditMetadata().mfa_required).toBe(true);
  });

  it('sends a user with no verified factor straight to the dashboard', async () => {
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.next).toBe('/dashboard');
    expect(auditMetadata().mfa_required).toBe(false);
  });

  it('does not invent a step-up when the AAL lookup returns nothing', async () => {
    // A missing AAL payload must not strand every user on /signin/mfa — that
    // page needs a factor to challenge and there is none.
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null });

    const res = await signInAction(INPUT);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.next).toBe('/dashboard');
  });
});
