import { beforeEach, describe, expect, it, vi } from 'vitest';

// sendPasswordResetForUser must deliver through the shared
// sendPasswordResetEmail helper (admin.generateLink → our /auth/confirm URL
// → Resend) — NOT supabase.auth.resetPasswordForEmail, whose built-in mailer
// is capped at ~2 emails/hour project-wide. That cap is exactly how the
// /platform "Send password reset" button failed live with "Could not send
// the reset email. Try again."

const generateLink = vi.fn();
const sendEmail = vi.fn();
const recordPlatformAudit = vi.fn();

type MaybeSingleResult = { data: Record<string, unknown> | null; error: { message: string } | null };

const dbState: { profile: MaybeSingleResult } = {
  profile: { data: null, error: null },
};

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink } },
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = vi.fn(() => q);
      q.eq = vi.fn(() => q);
      q.maybeSingle = vi.fn(async () => dbState.profile);
      return q;
    },
  }),
}));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args),
}));

import { sendPasswordResetForUser } from './users';

const INPUT = {
  targetUserId: '33333333-3333-3333-3333-333333333333',
  actorUserId: '44444444-4444-4444-4444-444444444444',
  actorEmail: 'operator@stockpilotusa.com',
};

describe('sendPasswordResetForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.profile = {
      data: { id: INPUT.targetUserId, email: 'user@example.com' },
      error: null,
    };
    sendEmail.mockResolvedValue({ ok: true });
    generateLink.mockResolvedValue({
      data: {
        user: { id: INPUT.targetUserId },
        properties: { action_link: 'https://sb/verify?token=abc', hashed_token: 'hash123' },
      },
      error: null,
    });
  });

  it('mints a recovery link, emails OUR /auth/confirm URL via Resend, and audits', async () => {
    const res = await sendPasswordResetForUser(INPUT);

    expect(res).toEqual({ ok: true, email: 'user@example.com' });
    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery', email: 'user@example.com' }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as { to: string; html: string; text: string };
    expect(msg.to).toBe('user@example.com');
    expect(msg.html).toContain('/auth/confirm?token_hash=hash123&type=recovery');
    expect(msg.html).not.toContain('https://sb/verify');
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'password_reset_sent',
        targetUserId: INPUT.targetUserId,
        actorUserId: INPUT.actorUserId,
      }),
    );
  });

  it('returns send_failed (and skips the audit row) when the send fails', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'resend down' });

    const res = await sendPasswordResetForUser(INPUT);

    expect(res).toEqual({ ok: false, reason: 'send_failed' });
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it('returns send_failed when the link cannot be minted', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'User not found' } });

    const res = await sendPasswordResetForUser(INPUT);

    expect(res).toEqual({ ok: false, reason: 'send_failed' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns not_found / no_email without minting anything', async () => {
    dbState.profile = { data: null, error: null };
    expect(await sendPasswordResetForUser(INPUT)).toEqual({ ok: false, reason: 'not_found' });

    dbState.profile = { data: { id: INPUT.targetUserId, email: null }, error: null };
    expect(await sendPasswordResetForUser(INPUT)).toEqual({ ok: false, reason: 'no_email' });

    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
