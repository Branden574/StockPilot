import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// Wire-level: createOrgForCustomerAction must keep its provisioning +
// generateLink minting exactly as before, and deliver the es ws-ready
// template (dedicated design — no longer the generic invite email) from
// the registry hello@ sender.

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

import { createOrgForCustomerAction } from './platform-admin';

describe('createOrgForCustomerAction — es ws-ready wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: {
        user: { id: 'auth-user-9' },
        properties: { hashed_token: 'hashWS', action_link: 'https://sb/verify?token=raw' },
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
      from?: string;
      replyTo?: string;
    };
    expect(msg.to).toBe('owner@acme.example');
    expect(msg.from).toBe('StockPilot <hello@stockpilotusa.com>');
    expect(msg.replyTo).toBeUndefined();
    // Registry subject, byte-equal.
    expect(msg.subject).toBe('Your Acme Co workspace on StockPilot is ready');
    // Still our server-verified confirm route that forces set-a-password.
    expect(msg.html).toContain('/auth/confirm?token_hash=hashWS&amp;type=invite');
    expect(msg.html).not.toContain('https://sb/verify');
    // The dedicated ws-ready design, not the old generic invite.
    expect(msg.html).toContain('Your workspace is ready.');
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
