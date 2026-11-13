import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * signOutAction is the person's "sign out everywhere": it revokes every
 * refresh token of the account, tells every live device on the account's
 * sessions channel to sign out now (they would otherwise keep working on their
 * access token for up to about an hour), and writes the user.signed_out row.
 *
 * Two answers from the Auth server used to cut that short:
 *
 *   - The account read before the sign-out came back empty (a 5xx or no
 *     answer: auth-js then returns no user and keeps the stored session).
 *     Nothing named the account, so the devices were not told and no row was
 *     written. The account is now named from the session's verified claims,
 *     read BEFORE the sign-out clears the cookie, and only when GoTrue named
 *     nobody; a session that does not verify names nobody, and nothing is sent
 *     or written for it.
 *   - The sign-out returned an error (auth-js returns it rather than throwing).
 *     Every other session stayed alive, and when the stored session could not
 *     be loaded this browser kept its own as well. The error is now read: the
 *     account's sessions are ended in the database instead, this browser's
 *     auth cookies are expired, and the row says what happened.
 */

const getUser = vi.fn();
const signOut = vi.fn();
const getSession = vi.fn();
const getClaims = vi.fn();
const cookieSet = vi.fn();
const cookieDelete = vi.fn();
const cookieGetAll = vi.fn();

const { auditInsert, broadcastToChannel, revokeAllSessionsForUser, reportError, redirect } =
  vi.hoisted(() => ({
    auditInsert: vi.fn(),
    broadcastToChannel: vi.fn(),
    revokeAllSessionsForUser: vi.fn(),
    reportError: vi.fn(),
    redirect: vi.fn(),
  }));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'user-agent': 'vitest-agent' })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    getAll: () => cookieGetAll(),
    set: (...args: unknown[]) => cookieSet(...args),
    delete: (...args: unknown[]) => cookieDelete(...args),
  })),
}));
vi.mock('next/navigation', () => ({ redirect: (...args: unknown[]) => redirect(...args) }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/auth/password-reset-email', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/auth/verify-password', () => ({ verifyPasswordSideChannel: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...args: unknown[]) => revokeAllSessionsForUser(...args),
}));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(),
  insertAuditRowReported: vi.fn(async (row: unknown) => {
    auditInsert(row);
    return true;
  }),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://sb.example.com',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
// resolveDefaultOrgAndRole's lookups: nulls are fine (organization_id is
// nullable on audit_logs).
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
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
  createClient: async () => ({ auth: { getUser, signOut, getSession, getClaims } }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: {} }) }));

import { signOutAction } from './auth';

// The cookie session's stored access token. Unsigned: the getClaims stub
// stands in for auth-js's verified read (verified-claims.test.ts runs it for
// real), so what the action may trust is what getClaims answers.
const STORED_ACCESS = `h.${Buffer.from(JSON.stringify({ sub: 'u2' })).toString('base64url')}.s`;

const GOTRUE_DOWN = {
  name: 'AuthRetryableFetchError',
  message: 'Service Unavailable',
  status: 503,
};

/** The Supabase auth cookies of this browser, chunked, and two that are not. */
const BROWSER_COOKIES = [
  { name: 'sb-x-auth-token', value: 'a' },
  { name: 'sb-x-auth-token.0', value: 'b' },
  { name: 'sb-x-auth-token.1', value: 'c' },
  { name: 'sb-x-auth-token-code-verifier', value: 'd' },
  { name: 'stockpilot-theme', value: 'dark' },
];

function signedOutRow(): Record<string, unknown> | undefined {
  return auditInsert.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((row) => row.event === 'user.signed_out');
}

function expiredCookieNames(): string[] {
  return cookieSet.mock.calls
    .filter((c) => c[1] === '' && (c[2] as { maxAge?: number } | undefined)?.maxAge === 0)
    .map((c) => c[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({
    data: { user: { id: 'u1', email: 'member@example.com' } },
    error: null,
  });
  signOut.mockResolvedValue({ error: null });
  getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } }, error: null });
  getClaims.mockResolvedValue({
    data: { claims: { sub: 'u2', session_id: 's2', aal: 'aal1' } },
    error: null,
  });
  cookieGetAll.mockReturnValue(BROWSER_COOKIES);
  broadcastToChannel.mockResolvedValue(undefined);
  revokeAllSessionsForUser.mockResolvedValue({ ok: true, sessionIds: [] });
});

describe('signOutAction', () => {
  it('signs out everywhere, tells every device and writes the row when the Auth server answers', async () => {
    await signOutAction();

    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u1:sessions', 'revoked', {
      keepId: null,
    });
    expect(signedOutRow()).toEqual(
      expect.objectContaining({
        user_id: 'u1',
        event: 'user.signed_out',
        metadata: expect.objectContaining({
          entity_id: 'u1',
          email: 'member@example.com',
          scope: 'global',
          revoke_error: null,
          database_revoke: 'not_needed',
        }),
      }),
    );
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(expiredCookieNames()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('names the account from the verified session when the first account read fails', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: GOTRUE_DOWN });

    await signOutAction();

    expect(broadcastToChannel).toHaveBeenCalledWith('user:u2:sessions', 'revoked', {
      keepId: null,
    });
    const row = signedOutRow();
    expect(row).toEqual(
      expect.objectContaining({
        user_id: 'u2',
        metadata: expect.objectContaining({ entity_id: 'u2', email: null, scope: 'global' }),
      }),
    );
    // Read before the sign-out, which clears the stored session.
    expect(getClaims).toHaveBeenCalled();
    expect(getClaims.mock.invocationCallOrder[0]!).toBeLessThan(
      signOut.mock.invocationCallOrder[0]!,
    );
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('with no session at all, signs out and sends and writes nothing', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
    });
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await signOutAction();

    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(signedOutRow()).toBeUndefined();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('names nobody from a session token that does not verify', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: GOTRUE_DOWN });
    getClaims.mockResolvedValue({
      data: null,
      error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
    });

    await signOutAction();

    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(signedOutRow()).toBeUndefined();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it('when the sign-out returns an error, ends the sessions in the database, expires the auth cookies and records it', async () => {
    signOut.mockResolvedValue({ error: GOTRUE_DOWN });

    await signOutAction();

    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith('u1');
    // The database revoke tells the devices itself when it worked.
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(signedOutRow()).toEqual(
      expect.objectContaining({
        user_id: 'u1',
        metadata: expect.objectContaining({
          revoke_error: 'AuthRetryableFetchError',
          database_revoke: 'ok',
        }),
      }),
    );
    expect(expiredCookieNames().sort()).toEqual([
      'sb-x-auth-token',
      'sb-x-auth-token.0',
      'sb-x-auth-token.1',
    ]);
    for (const call of cookieSet.mock.calls.filter((c) => c[1] === '')) {
      expect(call[2]).toEqual({ path: '/', maxAge: 0 });
    }
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, report] = reportError.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(report).toEqual(
      expect.objectContaining({
        tag: 'auth.sign_out_revoke_failed',
        level: 'warning',
        extra: expect.objectContaining({ database_revoke: 'ok' }),
      }),
    );
    // GoTrue's own words never go into the report.
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('Service Unavailable');
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('when the database revoke fails too, still tells every device and records both', async () => {
    signOut.mockResolvedValue({ error: GOTRUE_DOWN });
    revokeAllSessionsForUser.mockResolvedValue({ ok: false, sessionIds: [] });

    await signOutAction();

    expect(broadcastToChannel).toHaveBeenCalledWith('user:u1:sessions', 'revoked', {
      keepId: null,
    });
    expect(signedOutRow()).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          revoke_error: 'AuthRetryableFetchError',
          database_revoke: 'failed',
        }),
      }),
    );
  });

  it('when the sign-out fails and nobody can be named, expires the auth cookies and sends and writes nothing', async () => {
    signOut.mockResolvedValue({ error: GOTRUE_DOWN });
    getUser.mockResolvedValue({ data: { user: null }, error: GOTRUE_DOWN });
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await signOutAction();

    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(signedOutRow()).toBeUndefined();
    expect(expiredCookieNames().sort()).toEqual([
      'sb-x-auth-token',
      'sb-x-auth-token.0',
      'sb-x-auth-token.1',
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'auth.sign_out_revoke_failed',
        extra: expect.objectContaining({ database_revoke: 'no_account' }),
      }),
    );
  });

  it('reads the verified session only when the first account read names nobody', async () => {
    await signOutAction();

    expect(getSession).not.toHaveBeenCalled();
    expect(getClaims).not.toHaveBeenCalled();
  });
});
