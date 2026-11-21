import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant: the password reset's code step never asks for, or
 * checks, a code for a passkey's bridge factor (plan 3.1 #4).
 *
 * completePasswordResetAction picks the authenticator whose code it asks for
 * from the account's factor list. Supabase Auth lists the factors in an order
 * that flips with use (proof B7), so "the first verified one" was the bridge
 * after every passkey sign-in, and the member was asked for a code no app
 * shows. The pick is the first verified authenticator that is not the
 * account's RECORDED bridge (lib/auth/passkey-bridge.ts), whatever the order.
 * An account whose only factor is the bridge is never asked for its code
 * (GoTrue still refuses the new password without the second step). Before the
 * records exist, the pick is today's.
 */

vi.hoisted(() => {
  // A dull value under a neutral name (secret-shaped-fixtures guard): @/lib/env
  // reads it at import, as in auth.password-reset.test.ts.
  const SIGNING_INPUT = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_INPUT;
});

const getUser = vi.fn();
const getSession = vi.fn();
const getClaims = vi.fn();
const updateUser = vi.fn();
const signOut = vi.fn();
const listFactors = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const challenge = vi.fn();
const verify = vi.fn();
const bridgeRecord = vi.fn();

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    getAll: () => [],
    set: () => {},
    delete: () => {},
  })),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  unstable_rethrow: (await importOriginal<typeof import('next/navigation')>()).unstable_rethrow,
  redirect: vi.fn(),
}));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetAt: Date.now() + 1000 })),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastToChannel: vi.fn(async () => {}) }));
vi.mock('@/server/services/platform/sessions', () => ({ revokeAllSessionsForUser: vi.fn() }));
vi.mock('@/server/services/auth-audit', () => ({
  emitAuthAudit: vi.fn(async () => {}),
  resolveDefaultOrgAndRole: vi.fn(async () => ({ organizationId: null, role: null })),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () =>
        table === 'passkey_bridges' ? bridgeRecord() : { data: null, error: null };
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser,
      getSession,
      getClaims,
      updateUser,
      signOut,
      mfa: { listFactors, getAuthenticatorAssuranceLevel, challenge, verify },
    },
  }),
}));

import { completePasswordResetAction } from './auth';

const RESET_VALUE = 'Aa1xxxxxx';
const INPUT = { password: RESET_VALUE, confirmPassword: RESET_VALUE, totpCode: '123456' };
const APP = { id: 'app-1', status: 'verified', factor_type: 'totp', friendly_name: 'Phone' };
const BRIDGE = {
  id: 'bridge-1',
  status: 'verified',
  factor_type: 'totp',
  friendly_name: 'sp-passkey-bridge-a1b2c3',
};
const STORED_ACCESS = `h.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.s`;

function listed(...factors: Array<typeof APP>) {
  listFactors.mockResolvedValue({ data: { all: factors, totp: factors }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u@example.test' } } });
  getSession.mockResolvedValue({ data: { session: { access_token: STORED_ACCESS } }, error: null });
  getClaims.mockResolvedValue({
    data: {
      claims: {
        sub: 'u1',
        session_id: 's1',
        aal: 'aal1',
        // A session an emailed link made a minute ago (lib/auth/reset-link-session).
        amr: [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) - 60 }],
      },
    },
    error: null,
  });
  updateUser.mockResolvedValue({
    data: { user: { id: 'u1', email: 'u@example.test' } },
    error: null,
  });
  signOut.mockResolvedValue({ error: null });
  getAuthenticatorAssuranceLevel.mockResolvedValue({
    data: { currentLevel: 'aal1', nextLevel: 'aal2' },
  });
  challenge.mockResolvedValue({ data: { id: 'c1' }, error: null });
  verify.mockResolvedValue({ error: null });
  bridgeRecord.mockResolvedValue({ data: { factor_id: BRIDGE.id }, error: null });
});

describe('the reset picks an authenticator app, never the bridge', () => {
  it('the bridge listed first (after a passkey sign-in): the app is asked for', async () => {
    listed(BRIDGE, APP);
    const res = await completePasswordResetAction(INPUT);
    expect(res.ok).toBe(true);
    expect(challenge.mock.calls).toEqual([[{ factorId: APP.id }]]);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ factorId: APP.id }));
  });

  it('the app listed first: the app is asked for', async () => {
    listed(APP, BRIDGE);
    const res = await completePasswordResetAction(INPUT);
    expect(res.ok).toBe(true);
    expect(challenge.mock.calls).toEqual([[{ factorId: APP.id }]]);
  });

  it('an account whose only factor is the bridge is never asked for its code', async () => {
    listed(BRIDGE);
    // GoTrue refuses the new password without the second step.
    updateUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: 'AuthApiError',
        status: 401,
        code: 'insufficient_aal',
        message: 'AAL2 session is required to update email or password when MFA is enabled.',
      },
    });
    const res = await completePasswordResetAction(INPUT);
    expect(res.ok).toBe(false);
    expect(challenge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('before the records exist, the pick is today’s (the first verified factor)', async () => {
    listed(BRIDGE, APP);
    bridgeRecord.mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.passkey_bridges' in the schema cache",
      },
    });
    await completePasswordResetAction(INPUT);
    expect(challenge.mock.calls).toEqual([[{ factorId: BRIDGE.id }]]);
  });
});
