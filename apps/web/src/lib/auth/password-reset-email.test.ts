import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sendPasswordResetEmail emails OUR /auth/confirm link, built from the hashed
 * token generateLink returns, and never GoTrue's raw action_link (docket B39
 * review). The action_link hands its session back in the URL fragment, which
 * no server route reads and the browser client refuses (lib/supabase/
 * client.test.ts), so a person who pressed it landed on /signin with a spent
 * link, not signed in, and with live tokens in the address bar and in
 * analytics. A missing hashed token is a GoTrue fault: send nothing and report
 * it, as the portal invite (CustomersService) and the email change already do.
 * Placeholder values only.
 */

const generateLink = vi.fn();
const sendEmail = vi.fn();
const reportError = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink } } }),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

import { sendPasswordResetEmail } from './password-reset-email';

const ACTION_LINK =
  'https://project.example.invalid/auth/v1/verify?token=placeholder-otp&type=recovery';

function linkResult(properties: Record<string, unknown>) {
  return {
    data: {
      user: { id: 'user-1', user_metadata: { full_name: 'Placeholder Person' } },
      properties,
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ ok: true, id: 'message-1' });
});

describe('sendPasswordResetEmail', () => {
  it("emails our /auth/confirm link built from the hashed token, never GoTrue's action_link", async () => {
    generateLink.mockResolvedValue(
      linkResult({ hashed_token: 'placeholder-hash', action_link: ACTION_LINK }),
    );
    await expect(sendPasswordResetEmail('person@example.com')).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0]![0] as { to: string; html: string; text: string };
    expect(message.to).toBe('person@example.com');
    expect(message.text).toContain('/auth/confirm?token_hash=placeholder-hash&type=recovery');
    expect(message.html).not.toContain('auth/v1/verify');
    expect(message.text).not.toContain('auth/v1/verify');
  });

  it('sends nothing, and reports it, when GoTrue returns no hashed token', async () => {
    generateLink.mockResolvedValue(linkResult({ action_link: ACTION_LINK }));
    await expect(sendPasswordResetEmail('person@example.com')).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ tag: 'auth.password_reset_no_hashed_token' }),
    );
  });

  it('sends nothing and reports nothing for an address with no account (the public form hides it)', async () => {
    generateLink.mockResolvedValue({
      data: { user: null, properties: null },
      error: { message: 'User not found' },
    });
    await expect(sendPasswordResetEmail('nobody@example.com')).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
