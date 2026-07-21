import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';

import { TeamService } from './team';

// Wire-level: resendInvite must keep its token/expiry semantics (same
// token, fresh 7-day expiry) and send the es invite-REMINDER template —
// explicitly a reminder carrying the NEW expiry — from the registry
// hello@ sender.

vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));

function makeStub() {
  return makeSupabaseStub({
    'organization_invites.select': {
      data: {
        id: 'invite-1',
        email: 'theo@l4lnorth.com',
        role: 'staff',
        token: 'tokHvwVujKf',
        accepted_at: null,
        organizations: { name: 'L4L North Region' },
      },
      error: null,
    },
    'organization_invites.update': { data: null, error: null },
    'user_profiles.select': {
      data: { full_name: 'Branden Vincent Walker', email: 'branden@l4lnorth.com' },
      error: null,
    },
  });
}

describe('TeamService.resendInvite — es invite-reminder wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the reminder with the same token, from hello@, stating the new expiry', async () => {
    const stub = makeStub();
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const { acceptUrl } = await svc.resendInvite('invite-1');

    // Same token → same accept URL the original email carried.
    expect(acceptUrl).toContain('/i/tokHvwVujKf');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(sendEmail).mock.calls[0]![0] as {
      to: string | string[];
      subject: string;
      html: string;
      from?: string;
    };
    expect(msg.to).toBe('theo@l4lnorth.com');
    expect(msg.from).toBe('StockPilot <hello@stockpilotusa.com>');
    // Registry subject, byte-equal.
    expect(msg.subject).toBe(
      'Reminder: you’re invited to join L4L North Region on StockPilot',
    );
    // Explicitly a reminder + the NEW (bumped) expiry, formatted date.
    expect(msg.html).toContain('Reminder · still pending');
    expect(msg.html).toContain('a nudge, not a new invitation');
    expect(msg.html).toContain('It now expires');
    expect(msg.html).toContain('/i/tokHvwVujKf');

    // The expiry bump still happens (fresh 7 days from now).
    const updArgs = stub.chainArgs.get('organization_invites.update');
    expect(updArgs).toBeTruthy();
    const payload = updArgs![0]![0] as { expires_at: string };
    const bumpedMs = Date.parse(payload.expires_at) - Date.now();
    expect(bumpedMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(bumpedMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('refuses to resend an accepted invite', async () => {
    const stub = makeSupabaseStub({
      'organization_invites.select': {
        data: {
          id: 'invite-1',
          email: 'theo@l4lnorth.com',
          role: 'staff',
          token: 'tok',
          accepted_at: '2026-07-01T00:00:00Z',
          organizations: { name: 'L4L North Region' },
        },
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
