import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * changePasswordAction authenticates with a bare auth.getUser(). That is a
 * FOURTH identity funnel — it is not loadSessionAndContext, not withApiContext
 * and not resolvePortalContext — so nothing else in the request path consults
 * user_profiles.disabled_at on its behalf.
 *
 * Rotating your own password while disabled is a real escalation, not a
 * cosmetic gap: the disable flow revokes sessions and bans the GoTrue user, and
 * a password the operator does not know is exactly what an offboarded or
 * compromised account would want to establish before the ban propagates.
 */

const getUser = vi.fn();
const checkRateLimit = vi.fn();
const signInWithPassword = vi.fn();
const listFactors = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const updateUser = vi.fn();
const signOut = vi.fn();
const getSession = vi.fn();
const getClaims = vi.fn();
const maybeSingle = vi.fn();
const broadcastToChannel = vi.fn();
/**
 * The cookie client's rpc: list_my_sessions (the caller's sessions, the kept
 * one included) and revoke_my_other_sessions (the database backstop).
 */
const rpc = vi.fn();
// vi.hoisted: this spy is touched INSIDE a vi.mock factory (which vitest hoists
// above the module body), so a plain `const` would still be in its temporal
// dead zone when the factory runs.
const { verifyPasswordSideChannel, cookieGetAll, cookieSet, revokeAllSessionsForUser } = vi.hoisted(
  () => ({
    verifyPasswordSideChannel: vi.fn(),
    cookieGetAll: vi.fn((): Array<{ name: string; value: string }> => []),
    cookieSet: vi.fn(),
    revokeAllSessionsForUser: vi.fn(),
  }),
);

// The session id the action keeps alive is the VERIFIED one: the `session_id`
// claim getClaims() returns once the token's signature checks out. The stored
// session (getSession) holds a token naming ANOTHER session, unsigned, so a
// keepId read from it unchecked (as before 2026-10) shows up as 'sess-stored'.
const VERIFIED_CLAIMS = { sub: 'u-1', session_id: 'sess-1', aal: 'aal1' };
const STORED_PAYLOAD = { sub: 'u-1', session_id: 'sess-stored' };
const STORED_ACCESS = `h.${Buffer.from(JSON.stringify(STORED_PAYLOAD)).toString('base64url')}.s`;

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    getAll: () => cookieGetAll(),
    set: (...args: unknown[]) => cookieSet(...args),
    delete: () => {},
  })),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));
// Spy that DELEGATES to the real helper unless a test stubs a return value:
// the signInWithPassword assertions below keep working (the real helper drives
// the same mocked @supabase/supabase-js client), while the spy proves
// change-password re-confirms the password through the SHARED helper instead
// of its own inlined copy of it. Delegating per CALL rather than via
// mockImplementation survives the vi.clearAllMocks() in each beforeEach.
vi.mock('@/lib/auth/verify-password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/verify-password')>();
  return {
    verifyPasswordSideChannel: (...args: [string, string]) => {
      const stubbed = verifyPasswordSideChannel(...args);
      return stubbed === undefined ? actual.verifyPasswordSideChannel(...args) : stubbed;
    },
  };
});
vi.mock('@/server/services/audit', () => ({ audit: vi.fn() }));
// The by-user-id revoke behind a failed global sign-out (auth.ts
// endSessionsAfterFailedGlobalSignOut).
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...args: unknown[]) => revokeAllSessionsForUser(...args),
}));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: 'org-9', role: 'member' })),
}));
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
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: vi.fn(async () => ({ error: null })) }) }),
}));

// The SSR cookie client. `from('user_profiles')` is what the account-status
// guard reads; the auth namespace covers the rest of the action.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser,
      updateUser,
      signOut,
      getSession,
      getClaims,
      mfa: { listFactors, getAuthenticatorAssuranceLevel },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc,
  }),
}));

// The isolated in-memory client the action uses to verify the CURRENT password
// without disturbing the real session. A disabled caller must never reach it.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword } }),
}));

import { reportError } from '@/lib/error-reporter';
import { audit } from '@/server/services/audit';
import { emitAuthAudit } from '@/server/services/auth-audit';

import { changePasswordAction } from './auth';

// Dull values under neutral names (src/test/secret-shaped-fixtures.guard.test.ts).
const OLD_VALUE = 'OldPassw0rd!';
const NEW_VALUE = 'NewPassw0rd!123';
const INPUT = {
  currentPassword: OLD_VALUE,
  newPassword: NEW_VALUE,
  confirmPassword: NEW_VALUE,
};

describe('changePasswordAction — account status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'u@example.com' } } });
    checkRateLimit.mockResolvedValue({ allowed: true });
    signInWithPassword.mockResolvedValue({ error: null });
    listFactors.mockResolvedValue({ data: { totp: [] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } } });
    getClaims.mockResolvedValue({ data: { claims: VERIFIED_CLAIMS }, error: null });
    // Default: ACTIVE account.
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  });

  it('refuses a DISABLED account, and never checks or rotates the password', async () => {
    maybeSingle.mockResolvedValue({
      data: { disabled_at: '2026-07-31T00:00:00.000Z' },
      error: null,
    });

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');

    // The refusal must land BEFORE the side-channel password check and before
    // the rotation itself.
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not consume the rate-limit budget when refusing a disabled account', async () => {
    // The 5-per-15-min budget is keyed on the user. Spending it on a caller who
    // is refused unconditionally would let a disabled session lock the account
    // out of its own legitimate password change after re-enable.
    maybeSingle.mockResolvedValue({
      data: { disabled_at: '2026-07-31T00:00:00.000Z' },
      error: null,
    });

    await changePasswordAction(INPUT);

    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('refuses when the account status cannot be read, without rotating', async () => {
    // An authorization check that could not read its input has authorized
    // nothing. It must fail closed.
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses when the factor list cannot be read, instead of skipping the AAL2 check', async () => {
    listFactors.mockResolvedValue({ data: null, error: { name: 'AuthRetryableFetchError', message: 'x' } });
    const res = await changePasswordAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('still lets an ACTIVE account change its password', async () => {
    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith({ password: INPUT.newPassword });
  });
});

/**
 * SP-045 — `signOut({ scope: 'others' })` only revokes REFRESH tokens. Every
 * other browser keeps rendering RSC pages and writing through PostgREST with
 * its still-valid cookie JWT for up to an hour, and the mobile app keeps its
 * direct PostgREST reads. Both platforms already run a session-revocation
 * listener for exactly this window (see signOutAction and
 * completePasswordResetAction, which both broadcast) — change-password simply
 * never told it. A user who changes their password because a device was
 * compromised believes that device is out; it is not.
 *
 * SP-097 — the current-password re-confirm must go through the SHARED
 * verifyPasswordSideChannel helper, whose docstring names change-password as
 * its first intended caller. An inlined copy silently misses every future
 * hardening applied to the helper.
 */
const OTHER_A = '55555555-5555-4555-8555-555555555555';
const OTHER_B = '66666666-6666-4666-8666-666666666666';

describe('changePasswordAction — session revocation + shared password check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({
      data: [{ id: OTHER_A }, { id: 'sess-1' }, { id: OTHER_B }],
      error: null,
    });
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'u@example.com' } } });
    checkRateLimit.mockResolvedValue({ allowed: true });
    signInWithPassword.mockResolvedValue({ error: null });
    listFactors.mockResolvedValue({ data: { totp: [] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } } });
    getClaims.mockResolvedValue({ data: { claims: VERIFIED_CLAIMS }, error: null });
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  });

  it('broadcasts the revoke to other devices, naming the sessions it ended and never the one it kept', async () => {
    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' });
    // S5 (integrator decision 2026-11-01): `{ keepId: 'sess-1' }` put the LIVE
    // session id on the public channel. The ended ones are named instead.
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u-1:sessions', 'revoked', {
      sessionIds: [OTHER_A, OTHER_B],
    });
    expect(JSON.stringify(broadcastToChannel.mock.calls)).not.toContain('sess-1');
  });

  it('lists the sessions BEFORE the password changes: once the others are ended they cannot be named', async () => {
    await changePasswordAction(INPUT);
    expect(rpc).toHaveBeenCalledWith('list_my_sessions');
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(updateUser.mock.invocationCallOrder[0]!);
    expect(updateUser.mock.invocationCallOrder[0]!).toBeLessThan(
      broadcastToChannel.mock.invocationCallOrder[0]!,
    );
  });

  it('no other session, or a list that cannot be read: the password still changes, and nothing is broadcast', async () => {
    rpc.mockResolvedValueOnce({ data: [{ id: 'sess-1' }], error: null });
    expect((await changePasswordAction(INPUT)).ok).toBe(true);
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST000', message: 'connection refused' },
    });
    expect((await changePasswordAction(INPUT)).ok).toBe(true);
    expect(updateUser).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('a refused password change broadcasts nothing (the list before it was only a read)', async () => {
    updateUser.mockResolvedValueOnce({
      error: { message: 'Password should be at least 8 characters' },
    });
    expect((await changePasswordAction(INPUT)).ok).toBe(false);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('skips the broadcast when the current session id cannot be derived', async () => {
    // A `keepId: null` payload means "evict EVERY session" (signOutAction's
    // semantics) — broadcasting that here would sign the user out of the very
    // tab they just changed their password in. The session stops verifying
    // only after the update: before it, an unverifiable session changes
    // nothing (S78).
    updateUser.mockImplementation(async () => {
      getClaims.mockResolvedValue({ data: null, error: null });
      getSession.mockResolvedValue({ data: { session: null } });
      return { error: null };
    });

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('never aims the broadcast with a session id from a token that does not verify', async () => {
    // getClaims() refuses the stored token and so does GoTrue: the id it names
    // is not this session's, so nothing is kept and nothing is broadcast. The
    // token stops verifying only after the update (S78).
    updateUser.mockImplementation(async () => {
      getClaims.mockResolvedValue({
        data: null,
        error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
      });
      return { error: null };
    });
    getUser.mockImplementation(async (jwt?: string) =>
      jwt
        ? { data: { user: null }, error: { name: 'AuthApiError', message: 'invalid JWT' } }
        : { data: { user: { id: 'u-1', email: 'u@example.com' } } },
    );

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('re-confirms the current password through the shared side-channel helper', async () => {
    await changePasswordAction(INPUT);

    expect(verifyPasswordSideChannel).toHaveBeenCalledTimes(1);
    expect(verifyPasswordSideChannel).toHaveBeenCalledWith(
      'u@example.com',
      INPUT.currentPassword,
    );
  });

  it('refuses a wrong current password without rotating or revoking anything', async () => {
    verifyPasswordSideChannel.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_password',
      message: 'Password is incorrect.',
    });

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.message).toBe('Current password is incorrect');
    }
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

/**
 * signOut({ scope: 'others' }) returns a failure rather than throwing, so the
 * try/catch around it never saw one: the password changed and every other
 * session of the account stayed alive. The error is now read, and the other
 * sessions are ended in the database instead (revoke_my_other_sessions, which
 * keeps the session id given), only with this tab's VERIFIED session id: with
 * none, the function would end this session too.
 */
/**
 * The new password is set only for the account whose current password was
 * checked (S78): the cookie session is read once more right before the
 * update, and a session that now verifies as another account (a load
 * refreshed it into another account's) is signed out here and refused.
 */
describe('changePasswordAction — the update acts only as the account it checked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: [{ id: 'sess-1' }], error: null });
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'u@example.com' } } });
    checkRateLimit.mockResolvedValue({ allowed: true });
    signInWithPassword.mockResolvedValue({ error: null });
    listFactors.mockResolvedValue({ data: { totp: [] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } } });
    getClaims.mockResolvedValue({ data: { claims: VERIFIED_CLAIMS }, error: null });
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  });

  it('a session that verifies as another account at the update is refused and signed out here, and nothing changes', async () => {
    // The factor list loads the session; here it comes back as another account's.
    listFactors.mockImplementation(async () => {
      getClaims.mockResolvedValue({
        data: { claims: { sub: 'u-2', session_id: 'sess-9', aal: 'aal1' } },
        error: null,
      });
      return { data: { totp: [] } };
    });

    const res = await changePasswordAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Sign in again, then try again.',
        details: { reason: 'session_changed' },
      },
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a sign-in that cannot be verified right before the update changes nothing, and nobody is signed out', async () => {
    listFactors.mockImplementation(async () => {
      getClaims.mockResolvedValue({
        data: null,
        error: { name: 'AuthInvalidJwtError', message: 'Invalid JWT signature' },
      });
      return { data: { totp: [] } };
    });

    const res = await changePasswordAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message:
          'Could not confirm your sign-in just now, so your password was not changed. Try again in a moment.',
      },
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('an update that answers for another account is reported, that account is signed out everywhere, and its row is written', async () => {
    updateUser.mockResolvedValue({
      data: { user: { id: 'u-9', email: 'other@example.com' } },
      error: null,
    });

    const res = await changePasswordAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Sign in again, then try again.',
        details: { reason: 'session_changed' },
      },
    });
    // The report carries the tag and level only.
    const reports = vi
      .mocked(reportError)
      .mock.calls.filter(
        (c) => (c[1] as { tag?: string }).tag === 'auth.password_change_account_changed',
      );
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toEqual({ tag: 'auth.password_change_account_changed', level: 'error' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(signOut).not.toHaveBeenCalledWith({ scope: 'others' });
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u-9:sessions', 'revoked', {
      keepId: null,
    });
    expect(emitAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.password.changed',
        userId: 'u-9',
        organizationId: 'org-9',
        extra: expect.objectContaining({ account_changed: true }),
      }),
    );
    // Not the checked account's row.
    expect(audit).not.toHaveBeenCalled();
  });

  it('an update that answers for another account, when the global sign-out fails: that account is ended in the database and this browser loses its auth cookies', async () => {
    updateUser.mockResolvedValue({
      data: { user: { id: 'u-9', email: 'other@example.com' } },
      error: null,
    });
    signOut.mockResolvedValue({
      error: { name: 'AuthRetryableFetchError', message: 'Service Unavailable', status: 503 },
    });
    revokeAllSessionsForUser.mockResolvedValue({ ok: true, sessionIds: [] });
    cookieGetAll.mockReturnValue([
      { name: 'sb-x-auth-token', value: 'a' },
      { name: 'stockpilot-theme', value: 'dark' },
    ]);

    const res = await changePasswordAction(INPUT);

    expect(res).toEqual({
      ok: false,
      error: {
        code: 'unauthenticated',
        message: 'Sign in again, then try again.',
        details: { reason: 'session_changed' },
      },
    });
    expect(revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith('u-9');
    expect(cookieSet.mock.calls.map((c) => c[0])).toEqual(['sb-x-auth-token']);
    expect(cookieSet.mock.calls[0]!.slice(1)).toEqual(['', { path: '/', maxAge: 0 }]);
    // The database revoke tells the devices itself when it worked.
    expect(broadcastToChannel).not.toHaveBeenCalled();
    expect(emitAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.password.changed',
        userId: 'u-9',
        extra: expect.objectContaining({ account_changed: true, database_revoke: 'ok' }),
      }),
    );
    expect(audit).not.toHaveBeenCalled();
  });

  it('control: the same account is read again before the update, and the password changes as before', async () => {
    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    const updated = updateUser.mock.invocationCallOrder[0]!;
    const listed = listFactors.mock.invocationCallOrder[0]!;
    expect(
      getClaims.mock.invocationCallOrder.some((order) => order > listed && order < updated),
    ).toBe(true);
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' });
  });
});

describe('changePasswordAction — when the sign-out of the other sessions returns an error', () => {
  const GOTRUE_DOWN = {
    name: 'AuthRetryableFetchError',
    message: 'Service Unavailable',
    status: 503,
  };
  let revokeOthersAnswer: { data: unknown; error: { message: string } | null };

  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'u@example.com' } } });
    checkRateLimit.mockResolvedValue({ allowed: true });
    signInWithPassword.mockResolvedValue({ error: null });
    listFactors.mockResolvedValue({ data: { totp: [] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: GOTRUE_DOWN });
    getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } } });
    getClaims.mockResolvedValue({ data: { claims: VERIFIED_CLAIMS }, error: null });
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
    revokeOthersAnswer = { data: 2, error: null };
    rpc.mockImplementation(async (fn: string) =>
      fn === 'list_my_sessions'
        ? { data: [{ id: OTHER_A }, { id: 'sess-1' }, { id: OTHER_B }], error: null }
        : revokeOthersAnswer,
    );
  });

  /** The calls to the database revoke, apart from the session list read before the change. */
  const revokeCalls = () => rpc.mock.calls.filter(([fn]) => fn === 'revoke_my_other_sessions');

  it("ends the other sessions in the database, keeping this tab's verified session, and records it", async () => {
    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(revokeCalls()).toEqual([['revoke_my_other_sessions', { p_keep_session_id: 'sess-1' }]]);
    // The devices are told which sessions ended, never the one that stays (S5).
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u-1:sessions', 'revoked', {
      sessionIds: [OTHER_A, OTHER_B],
    });
    expect(JSON.stringify(broadcastToChannel.mock.calls)).not.toContain('sess-1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.password.changed',
        extra: { revoke_error: 'AuthRetryableFetchError', database_revoke: 'ok' },
      }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'auth.password_change_revoke_failed',
        extra: expect.objectContaining({ database_revoke: 'ok' }),
      }),
    );
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain('Service Unavailable');
  });

  it('records a database revoke that failed', async () => {
    revokeOthersAnswer = { data: null, error: { message: 'db down' } };

    await changePasswordAction(INPUT);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: { revoke_error: 'AuthRetryableFetchError', database_revoke: 'failed' },
      }),
    );
  });

  it('never calls the database revoke without a verified session id', async () => {
    // The session stops verifying only after the update (S78).
    updateUser.mockImplementation(async () => {
      getClaims.mockResolvedValue({ data: null, error: null });
      getSession.mockResolvedValue({ data: { session: null } });
      return { error: null };
    });

    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(revokeCalls()).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: { revoke_error: 'AuthRetryableFetchError', database_revoke: 'no_session_id' },
      }),
    );
  });

  it('a sign-out that answers records that no database revoke was needed', async () => {
    signOut.mockResolvedValue({ error: null });

    await changePasswordAction(INPUT);

    expect(revokeCalls()).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.password.changed',
        extra: { revoke_error: null, database_revoke: 'not_needed' },
      }),
    );
  });
});
