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
const maybeSingle = vi.fn();
const broadcastToChannel = vi.fn();
// vi.hoisted: this spy is touched INSIDE a vi.mock factory (which vitest hoists
// above the module body), so a plain `const` would still be in its temporal
// dead zone when the factory runs.
const { verifyPasswordSideChannel } = vi.hoisted(() => ({
  verifyPasswordSideChannel: vi.fn(),
}));

// A real (unsigned) access token whose payload carries the session id, so the
// keepId below is produced by the REAL sessionIdFromJwt rather than a mock.
const ACCESS_TOKEN = `h.${Buffer.from(JSON.stringify({ session_id: 'sess-1' })).toString('base64url')}.s`;

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
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
      mfa: { listFactors, getAuthenticatorAssuranceLevel },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

// The isolated in-memory client the action uses to verify the CURRENT password
// without disturbing the real session. A disabled caller must never reach it.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword } }),
}));

import { changePasswordAction } from './auth';

const INPUT = {
  currentPassword: 'OldPassw0rd!',
  newPassword: 'NewPassw0rd!123',
  confirmPassword: 'NewPassw0rd!123',
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
    getSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } } });
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
describe('changePasswordAction — session revocation + shared password check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'u@example.com' } } });
    checkRateLimit.mockResolvedValue({ allowed: true });
    signInWithPassword.mockResolvedValue({ error: null });
    listFactors.mockResolvedValue({ data: { totp: [] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: { access_token: ACCESS_TOKEN } } });
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  });

  it('broadcasts the revoke to other devices, keeping the current session alive', async () => {
    const res = await changePasswordAction(INPUT);

    expect(res.ok).toBe(true);
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u-1:sessions', 'revoked', {
      keepId: 'sess-1',
    });
  });

  it('skips the broadcast when the current session id cannot be derived', async () => {
    // A `keepId: null` payload means "evict EVERY session" (signOutAction's
    // semantics) — broadcasting that here would sign the user out of the very
    // tab they just changed their password in.
    getSession.mockResolvedValue({ data: { session: null } });

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
  });
});
