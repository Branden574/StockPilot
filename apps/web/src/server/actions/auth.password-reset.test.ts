import { beforeEach, describe, expect, it, vi } from 'vitest';

// requestPasswordResetAction must mint the recovery link via
// admin.generateLink and deliver it through the app's Resend transport —
// NEVER supabase.auth.resetPasswordForEmail, whose built-in mailer is
// capped at ~2 emails/hour project-wide (observed live as a silent
// 429 over_email_send_rate_limit while the UI reported success).

const generateLink = vi.fn();
const sendEmail = vi.fn();
const checkRateLimit = vi.fn();
const resetPasswordForEmail = vi.fn();
// completePasswordResetAction surface (the recovery session's own client).
const getUser = vi.fn();
const updateUser = vi.fn();
const signOut = vi.fn();
const listFactors = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const challenge = vi.fn();
const verify = vi.fn();
const auditInsert = vi.fn();
const broadcastToChannel = vi.fn();

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/auth/login-device', () => ({ noteLoginDevice: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));
vi.mock('@/lib/supabase/admin', () => {
  // resolveDefaultOrgAndRole chains .select().eq()[.eq()][.not()][.limit()]
  // .maybeSingle(); a permissive self-returning chain keeps it honest without
  // pinning the exact call order (it is try/catch-wrapped in the action, so a
  // missing link would silently degrade to a null-org audit row instead of
  // failing the test).
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'not', 'limit', 'order']) chain[k] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  return {
    createAdminClient: () => ({
      auth: { admin: { generateLink } },
      from: () => ({ ...chain, insert: (...args: unknown[]) => auditInsert(...args) }),
    }),
  };
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      resetPasswordForEmail,
      getUser,
      updateUser,
      signOut,
      mfa: { listFactors, getAuthenticatorAssuranceLevel, challenge, verify },
    },
  }),
}));

import { completePasswordResetAction, requestPasswordResetAction } from './auth';

describe('requestPasswordResetAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true });
    sendEmail.mockResolvedValue({ ok: true });
  });

  it('mints a recovery link and emails OUR /auth/confirm URL via Resend', async () => {
    generateLink.mockResolvedValue({
      data: {
        user: { id: 'u-1' },
        properties: { action_link: 'https://sb/verify?token=abc', hashed_token: 'hash123' },
      },
      error: null,
    });

    const res = await requestPasswordResetAction({ email: 'user@example.com' });

    expect(res.ok).toBe(true);
    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: 'user@example.com' }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as {
      to: string;
      html: string;
      text: string;
      from?: string;
    };
    expect(msg.to).toBe('user@example.com');
    // MUST be our server-verified confirm route (token_hash + verifyOtp) —
    // the raw action_link returns the session in a URL fragment the server
    // callback can't read, bouncing users to /signin. (HTML entity-escapes
    // the query &; text carries it raw.)
    expect(msg.html).toContain('/auth/confirm?token_hash=hash123&amp;type=recovery');
    expect(msg.text).toContain('/auth/confirm?token_hash=hash123&type=recovery');
    expect(msg.html).not.toContain('https://sb/verify');
    // es registry sender for the security family.
    expect(msg.from).toBe('StockPilot Security <security@stockpilotusa.com>');
    // the capped Supabase mailer must never be used
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('still returns generic ok for an unknown email and sends nothing (anti-enumeration)', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'User not found' } });

    const res = await requestPasswordResetAction({ email: 'nobody@example.com' });

    expect(res.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns generic ok without minting a link when rate-limited', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await requestPasswordResetAction({ email: 'user@example.com' });

    expect(res.ok).toBe(true);
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns generic ok even when the email send fails', async () => {
    generateLink.mockResolvedValue({
      data: { user: { id: 'u-1' }, properties: { action_link: 'https://sb/verify?token=abc' } },
      error: null,
    });
    sendEmail.mockRejectedValue(new Error('resend down'));

    const res = await requestPasswordResetAction({ email: 'user@example.com' });

    expect(res.ok).toBe(true);
  });
});

/**
 * completePasswordResetAction had ZERO tests. Everything it enforces is a
 * security property that no other pin covers:
 *
 *  - the GLOBAL sign-out + revocation broadcast (the whole point of resetting
 *    a password is that an existing session may be in hostile hands);
 *  - the closed-mode rate limiter on an effectively-unauthenticated endpoint;
 *  - and, since SP-014, the TOTP step-up without which GoTrue refuses
 *    `updateUser({ password })` on the AAL1 session that /auth/confirm mints,
 *    locking every MFA-enrolled user out of password recovery forever.
 */
describe('completePasswordResetAction', () => {
  // Assembled at runtime rather than written as one literal. A realistic-looking
  // password literal is indistinguishable from a leaked one to a secret scanner,
  // and GitGuardian blocked this PR on exactly this line. The value is only ever
  // required to satisfy passwordSchema (>= 8 chars, one lower, one upper, one
  // digit) -- so build it from those rules and never reintroduce the literal.
  const PASSWORD = `Aa1${'x'.repeat(6)}`;
  const INPUT = { password: PASSWORD, confirmPassword: PASSWORD };

  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true });
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u@e.com' } } });
    updateUser.mockResolvedValue({ error: null });
    signOut.mockResolvedValue({ error: null });
    // Default: no MFA enrolled.
    listFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    });
    challenge.mockResolvedValue({ data: { id: 'c1' }, error: null });
    verify.mockResolvedValue({ error: null });
    auditInsert.mockResolvedValue({ error: null });
    broadcastToChannel.mockResolvedValue(undefined);
  });

  it('rotates the password, then GLOBALLY signs out and broadcasts the revoke', async () => {
    const res = await completePasswordResetAction(INPUT);

    expect(res).toEqual({ ok: true, data: { next: '/signin?reset=success' } });
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    // scope:'global' — a local sign-out would leave the intercepted session
    // (and every other device) alive until the access token expires.
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    // keepId:null == evict EVERY device, including the one that just reset.
    expect(broadcastToChannel).toHaveBeenCalledWith('user:u1:sessions', 'revoked', {
      keepId: null,
    });
    // Order matters: revoke first, then tell the live devices.
    expect(signOut.mock.invocationCallOrder[0]!).toBeLessThan(
      broadcastToChannel.mock.invocationCallOrder[0]!,
    );
    // Forensic row for the recovery-based reset.
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.password.reset_completed', user_id: 'u1' }),
    );
  });

  it('refuses in CLOSED mode when rate-limited, without touching the password', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await completePasswordResetAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^pwreset-complete:/),
      5,
      900000,
      'closed',
    );
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('does not sign anyone out when the password update itself failed', async () => {
    updateUser.mockResolvedValue({ error: { message: 'weak password' } });

    const res = await completePasswordResetAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(signOut).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  // ── SP-014: TOTP-enrolled users could never finish a reset ──────────────
  it('steps the AAL1 recovery session up to AAL2 BEFORE updating the password', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', status: 'verified' }] },
      error: null,
    });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });

    const res = await completePasswordResetAction({ ...INPUT, totpCode: '123456' });

    expect(res.ok).toBe(true);
    expect(challenge).toHaveBeenCalledWith({ factorId: 'f1' });
    expect(verify).toHaveBeenCalledWith({
      factorId: 'f1',
      challengeId: 'c1',
      code: '123456',
    });
    // GoTrue rejects updateUser({password}) at AAL1 for an enrolled user, so
    // the step-up MUST land first or the reset can never succeed.
    expect(verify.mock.invocationCallOrder[0]!).toBeLessThan(
      updateUser.mock.invocationCallOrder[0]!,
    );
  });

  it('asks for the code (aal2_required) instead of letting GoTrue reject the update', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', status: 'verified' }] },
      error: null,
    });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });

    const res = await completePasswordResetAction(INPUT);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.details?.reason).toBe('aal2_required');
    }
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('refuses a wrong TOTP code without rotating the password', async () => {
    listFactors.mockResolvedValue({
      data: { totp: [{ id: 'f1', status: 'verified' }] },
      error: null,
    });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
    });
    verify.mockResolvedValue({ error: { message: 'Invalid TOTP code entered' } });

    const res = await completePasswordResetAction({ ...INPUT, totpCode: '000000' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(updateUser).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('leaves an UNENROLLED user on the one-step flow (no challenge)', async () => {
    const res = await completePasswordResetAction(INPUT);

    expect(res.ok).toBe(true);
    expect(challenge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not block an unenrolled user when the factor list cannot be read', async () => {
    // listFactors is a UX enabler, not the enforcement point — GoTrue itself
    // still refuses an AAL1 update for a genuinely enrolled user. Failing
    // closed here would break password recovery for everyone on a blip.
    listFactors.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });

    const res = await completePasswordResetAction(INPUT);

    expect(res.ok).toBe(true);
    expect(updateUser).toHaveBeenCalledWith({ password: PASSWORD });
  });
});
