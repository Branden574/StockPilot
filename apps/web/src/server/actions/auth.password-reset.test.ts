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
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink } },
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { resetPasswordForEmail } }),
}));

import { requestPasswordResetAction } from './auth';

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
