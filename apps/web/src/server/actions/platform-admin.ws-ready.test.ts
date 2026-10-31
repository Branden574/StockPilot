import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// Wire-level: createOrgForCustomerAction must keep its provisioning +
// generateLink minting exactly as before, and deliver the es ws-ready
// template (dedicated design — no longer the generic invite email) from
// the registry hello@ sender.
//
// Docket S25: the invite link carries `r`, the account it is for, signed for
// the new owner's user id that GoTrue returned (checked with the app's own
// checker); a link that cannot be signed is not sent. The signing value is a
// dull one under a neutral name, set before @/lib/env reads the environment
// (src/test/secret-shaped-fixtures.guard.test.ts).
vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_INPUT;
});

const sendEmail = vi.fn();
const generateLink = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/server/services/platform/audit', () => ({
  recordPlatformAudit: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'pa-1', email: 'ops@stockpilotusa.com' },
  })),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const adminStub = makeSupabaseStub({
  // ensureUniqueSlug collision probe → no collision.
  'organizations.select': { data: null, error: null },
  'organizations.insert': { data: [{ id: 'org-1', slug: 'acme-co' }], error: null },
});
(adminStub.client.auth as { admin?: unknown }).admin = { generateLink };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { env } from '@/lib/env';
import { emailedConfirmLink } from '@/test/confirm-link-check';

import { createOrgForCustomerAction } from './platform-admin';

/** The new owner's auth user, as GoTrue's generateLink returns it. */
const NEW_OWNER_ID = '99999999-9999-4999-8999-999999999999';
/** GoTrue's hashed token is a sha224 in hex: 56 characters. */
const LINK_HASH = 'ab'.repeat(28);
const SIGNING_COPY = env.SUPABASE_SERVICE_ROLE_KEY;

describe('createOrgForCustomerAction — es ws-ready wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_COPY;
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: {
        user: { id: NEW_OWNER_ID },
        properties: { hashed_token: LINK_HASH, action_link: 'https://sb/verify?token=raw' },
      },
      error: null,
    });
  });

  it('provisions the org and sends the workspace-ready email from hello@', async () => {
    const res = await createOrgForCustomerAction({
      email: 'owner@acme.example',
      name: 'Acme Co',
      timezone: 'America/Los_Angeles',
    });

    expect(res.ok).toBe(true);
    // Minting unchanged: generateLink invite, never the built-in mailer.
    expect(generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'invite', email: 'owner@acme.example' }),
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      from?: string;
      replyTo?: string;
    };
    expect(msg.to).toBe('owner@acme.example');
    expect(msg.from).toBe('StockPilot <hello@stockpilotusa.com>');
    expect(msg.replyTo).toBeUndefined();
    // Registry subject, byte-equal.
    expect(msg.subject).toBe('Your Acme Co workspace on StockPilot is ready');
    // Still our server-verified confirm route that forces set-a-password.
    expect(msg.html).toContain(`/auth/confirm?token_hash=${LINK_HASH}&amp;type=invite`);
    expect(msg.html).not.toContain('https://sb/verify');
    // The dedicated ws-ready design, not the old generic invite.
    expect(msg.html).toContain('Your workspace is ready.');
    // S25: the page will name the new owner, the account GoTrue just made.
    expect(emailedConfirmLink(msg.text)).toMatchObject({
      type: 'invite',
      next: '/reset/complete',
      recipient: NEW_OWNER_ID,
    });
  });

  it.each([
    ['no service key to sign with', () => (env.SUPABASE_SERVICE_ROLE_KEY = ''), NEW_OWNER_ID],
    ['a user id that is not a UUID', () => {}, 'auth-user-9'],
  ])(
    'sends nothing, reports it and tells the operator when the invite link cannot be signed: %s',
    async (_label, arrange, userId) => {
      arrange();
      generateLink.mockResolvedValue({
        data: {
          user: { id: userId },
          properties: { hashed_token: LINK_HASH, action_link: 'https://sb/verify?token=raw' },
        },
        error: null,
      });
      const { reportError } = await import('@/lib/error-reporter');
      const res = await createOrgForCustomerAction({
        email: 'owner@acme.example',
        name: 'Acme Co',
        timezone: 'America/Los_Angeles',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toMatch(/Org created, but no invite link could be made/);
        expect(res.error.message).toMatch(/Send password reset/);
      }
      expect(sendEmail).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tag: 'platform-admin.invite-link' }),
      );
    },
  );

  // Docket B39 review: GoTrue's raw action_link hands its session back in the
  // URL fragment, which the app never uses, so an owner who pressed it landed
  // on /signin, not signed in, with live tokens in the address bar. With no
  // hashed token there is no link of ours to send.
  it('sends nothing, reports it and tells the operator when GoTrue returns no hashed token, never the action_link', async () => {
    generateLink.mockResolvedValue({
      data: {
        user: { id: NEW_OWNER_ID },
        properties: { action_link: 'https://sb/verify?token=raw' },
      },
      error: null,
    });
    const { reportError } = await import('@/lib/error-reporter');
    const res = await createOrgForCustomerAction({
      email: 'owner@acme.example',
      name: 'Acme Co',
      timezone: 'America/Los_Angeles',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toMatch(/Org created, but no invite link could be made/);
      expect(res.error.message).toMatch(/Send password reset/);
    }
    expect(sendEmail).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'platform-admin.invite-link' }),
    );
  });

  it('surfaces a send failure without rolling back the org', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'resend down' });
    const res = await createOrgForCustomerAction({
      email: 'owner@acme.example',
      name: 'Acme Co',
      timezone: 'America/Los_Angeles',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/invite email failed to send/);
  });
});
