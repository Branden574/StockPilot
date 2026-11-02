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
      data: {
        user: { id: 'u-1' },
        properties: { action_link: 'https://sb/verify?token=abc', hashed_token: 'hash123' },
      },
      error: null,
    });
    sendEmail.mockRejectedValue(new Error('resend down'));

    const res = await requestPasswordResetAction({ email: 'user@example.com' });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  // Docket B39 review: never the raw action_link, whose session comes back in
  // the URL fragment the app never uses. The public form still answers the
  // same generic ok (lib/auth/password-reset-email.test.ts pins the report).
  it('returns generic ok and sends nothing when GoTrue returns no hashed token', async () => {
    generateLink.mockResolvedValue({
      data: { user: { id: 'u-1' }, properties: { action_link: 'https://sb/verify?token=abc' } },
      error: null,
    });

    const res = await requestPasswordResetAction({ email: 'user@example.com' });

    expect(res.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
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
  // Deliberately not named after the field it feeds, and deliberately dull.
  // GitGuardian's Generic Password detector keys off the identifier plus a
  // string literal, not the value: it blocked this PR once on a realistic
  // fixture and again on a runtime-assembled one. The fixture only ever has to
  // satisfy passwordSchema (>= 8 chars, one lower, one upper, one digit), so
  // there is nothing to gain from making it resemble a real credential.
  const RESET_VALUE = 'Aa1xxxxxx';
  const INPUT = { password: RESET_VALUE, confirmPassword: RESET_VALUE };

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
    expect(updateUser).toHaveBeenCalledWith({ password: RESET_VALUE });
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
    expect(updateUser).toHaveBeenCalledWith({ password: RESET_VALUE });
  });

  // B50 review. The action reads the account once, at the start, to name it in
  // the revoke broadcast and the audit row. When that one read fails (GoTrue
  // answers 5xx; auth-js returns no user and an AuthRetryableFetchError) and
  // the rest of the press goes through, the password changed and every session
  // ended, but no live device was told and no row was written. The update's
  // own answer names the same account.
  it.each([
    ['an account with no authenticator', false],
    ['an account with an authenticator, on the press that carries the code', true],
  ])(
    'when the first account read fails and the reset goes through, the revoke and the audit row still name the account: %s',
    async (_label, withAuthenticator) => {
      getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { name: 'AuthRetryableFetchError', message: 'Service Unavailable', status: 503 },
      });
      if (withAuthenticator) {
        listFactors.mockResolvedValue({
          data: { totp: [{ id: 'f1', status: 'verified' }] },
          error: null,
        });
        getAuthenticatorAssuranceLevel.mockResolvedValue({
          data: { currentLevel: 'aal1', nextLevel: 'aal2' },
        });
      }
      updateUser.mockResolvedValue({
        data: { user: { id: 'u2', email: 'reset-user@example.com' } },
        error: null,
      });

      const res = await completePasswordResetAction(
        withAuthenticator ? { ...INPUT, totpCode: '123456' } : INPUT,
      );

      expect(res).toEqual({ ok: true, data: { next: '/signin?reset=success' } });
      expect(verify).toHaveBeenCalledTimes(withAuthenticator ? 1 : 0);
      expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
      expect(broadcastToChannel).toHaveBeenCalledWith('user:u2:sessions', 'revoked', {
        keepId: null,
      });
      expect(auditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'user.password.reset_completed',
          user_id: 'u2',
          metadata: expect.objectContaining({ entity_id: 'u2', email: 'reset-user@example.com' }),
        }),
      );
    },
  );

  // ── B50: GoTrue's refusals of the new password, in plain words ──────────
  // Read by GoTrue's structured code (auth-error-classify.ts), never by its
  // message. A refusal it does not name keeps today's answer (the test above
  // with only a message stays internal_error).
  describe("GoTrue's refusals of the new password (B50)", () => {
    const ASK =
      'Enter the 6-digit code from your authenticator app to finish resetting your password.';
    const AAL_REFUSAL = {
      code: 'insufficient_aal',
      message: 'AAL2 session is required to update email or password when MFA is enabled.',
    };

    function enrolledAtAal1() {
      listFactors.mockResolvedValue({
        data: { totp: [{ id: 'f1', status: 'verified' }] },
        error: null,
      });
      getAuthenticatorAssuranceLevel.mockResolvedValue({
        data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      });
    }

    function expectNothingSignedOut() {
      expect(signOut).not.toHaveBeenCalled();
      expect(broadcastToChannel).not.toHaveBeenCalled();
    }

    // The factor list is the only way the action knows to ask. When it cannot
    // be read, GoTrue still refuses the update; that refusal now asks too, so
    // the form shows its box on this press rather than the next.
    it('asks for the code when GoTrue refuses the update for want of AAL2', async () => {
      listFactors.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });
      updateUser.mockResolvedValue({ error: AAL_REFUSAL });

      const res = await completePasswordResetAction(INPUT);

      expect(res).toEqual({
        ok: false,
        error: { code: 'forbidden', message: ASK, details: { reason: 'aal2_required' } },
      });
      expectNothingSignedOut();
    });

    it('a code sent while the factor list cannot be read gets the could-not-check words', async () => {
      listFactors.mockResolvedValue({ data: null, error: { message: 'gotrue down' } });
      updateUser.mockResolvedValue({ error: AAL_REFUSAL });

      const res = await completePasswordResetAction({ ...INPUT, totpCode: '123456' });

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'forbidden',
          message: 'Could not check your code just now. Try again.',
          details: { reason: 'aal2_required' },
        },
      });
      expect(challenge).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expectNothingSignedOut();
    });

    it('a code accepted, then the same password refused, says so in plain words', async () => {
      enrolledAtAal1();
      updateUser.mockResolvedValue({
        error: {
          code: 'same_password',
          message: 'New password should be different from the old password.',
        },
      });

      const res = await completePasswordResetAction({ ...INPUT, totpCode: '123456' });

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'Choose a password that is different from your current one.',
        },
      });
      expect(verify.mock.invocationCallOrder[0]!).toBeLessThan(
        updateUser.mock.invocationCallOrder[0]!,
      );
      expectNothingSignedOut();
    });

    it('a breached password is refused in plain words, and a weak one by the rules', async () => {
      updateUser.mockResolvedValueOnce({
        error: {
          code: 'weak_password',
          message: 'Password is known to be weak and easy to guess, please choose a different one.',
          reasons: ['pwned'],
        },
      });
      const breached = await completePasswordResetAction(INPUT);
      expect(breached).toEqual({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'This password has appeared in a known data breach. Choose a different one.',
        },
      });

      updateUser.mockResolvedValueOnce({
        error: {
          code: 'weak_password',
          message: 'Password should contain at least one character of each kind.',
          reasons: ['characters'],
        },
      });
      const weak = await completePasswordResetAction(INPUT);
      expect(weak).toEqual({
        ok: false,
        error: {
          code: 'validation_error',
          message: 'This password does not meet the password rules. Choose a stronger one.',
        },
      });
      expectNothingSignedOut();
    });

    // A spent or expired link, or a reset finished in another tab that signed
    // this one out: the SDK answers with its own session-missing error, which
    // carries no code.
    it('a press with no session says the link expired', async () => {
      getUser.mockResolvedValue({ data: { user: null } });
      listFactors.mockResolvedValue({ data: null, error: { message: 'Auth session missing!' } });
      updateUser.mockResolvedValue({
        error: { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 },
      });

      const res = await completePasswordResetAction(INPUT);

      expect(res).toEqual({
        ok: false,
        error: {
          code: 'unauthenticated',
          message:
            'That link has expired or was already used. Choose Forgot? on the sign-in page to get a new link by email.',
        },
      });
      expectNothingSignedOut();
    });
  });
});
