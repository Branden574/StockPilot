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
 *
 * Docket S25: the link carries `r`, the account it is for, signed for the user
 * id GoTrue returned with the token (checked here with the app's own checker,
 * lib/auth/confirm-link.ts). A link that cannot be signed (no service key, or
 * an id that is not a UUID) is not sent, and is reported.
 * Placeholder values only; the signing value is a dull one under a neutral
 * name (src/test/secret-shaped-fixtures.guard.test.ts).
 */

vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_INPUT;
});

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

import { env } from '@/lib/env';
import { emailedConfirmLink } from '@/test/confirm-link-check';

import { sendPasswordResetEmail } from './password-reset-email';

const ACTION_LINK =
  'https://project.example.invalid/auth/v1/verify?token=placeholder-otp&type=recovery';
const USER_ID = '11111111-1111-4111-8111-111111111111';
/** GoTrue's hashed token is a sha224 in hex: 56 characters. */
const LINK_HASH = 'ab'.repeat(28);
const SIGNING_COPY = env.SUPABASE_SERVICE_ROLE_KEY;

function linkResult(properties: Record<string, unknown>, userId: string = USER_ID) {
  return {
    data: {
      user: { id: userId, user_metadata: { full_name: 'Placeholder Person' } },
      properties,
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_COPY;
  sendEmail.mockResolvedValue({ ok: true, id: 'message-1' });
});

describe('sendPasswordResetEmail', () => {
  it("emails our /auth/confirm link built from the hashed token, never GoTrue's action_link", async () => {
    generateLink.mockResolvedValue(
      linkResult({ hashed_token: LINK_HASH, action_link: ACTION_LINK }),
    );
    await expect(sendPasswordResetEmail('person@example.com')).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0]![0] as { to: string; html: string; text: string };
    expect(message.to).toBe('person@example.com');
    expect(message.text).toContain(`/auth/confirm?token_hash=${LINK_HASH}&type=recovery`);
    expect(message.html).not.toContain('auth/v1/verify');
    expect(message.text).not.toContain('auth/v1/verify');
  });

  it('the link names the account GoTrue made it for, signed for a recovery link', async () => {
    generateLink.mockResolvedValue(
      linkResult({ hashed_token: LINK_HASH, action_link: ACTION_LINK }),
    );
    await sendPasswordResetEmail('person@example.com');
    const link = emailedConfirmLink((sendEmail.mock.calls[0]![0] as { text: string }).text);
    expect(link).toMatchObject({
      tokenHash: LINK_HASH,
      type: 'recovery',
      next: '/reset/complete',
      recipient: USER_ID,
    });
    expect([...link.url.searchParams.keys()]).toEqual(['token_hash', 'type', 'next', 'r']);
  });

  it.each([
    ['no service key to sign with', () => (env.SUPABASE_SERVICE_ROLE_KEY = ''), USER_ID],
    ['a user id that is not a UUID', () => {}, 'user-1'],
  ])(
    'sends nothing, and reports it, when the link cannot be signed: %s',
    async (_label, arrange, userId) => {
      arrange();
      generateLink.mockResolvedValue(
        linkResult({ hashed_token: LINK_HASH, action_link: ACTION_LINK }, userId),
      );
      await expect(sendPasswordResetEmail('person@example.com')).resolves.toBe(false);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toEqual(
        expect.objectContaining({ tag: 'auth.confirm_link_unsigned' }),
      );
      // The report carries neither the token nor the account.
      const reported = JSON.stringify(reportError.mock.calls, (_k, v) =>
        v instanceof Error ? v.message : v,
      );
      expect(reported).not.toContain(LINK_HASH);
      expect(reported).not.toContain(USER_ID);
      expect(reported).not.toContain('person@example.com');
    },
  );

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
