import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';

import { audit } from './audit';
import { TeamService } from './team';

// Wire-level: resendInvite must keep its token/expiry semantics (same
// token, fresh 7-day expiry) and send the es invite-REMINDER template —
// explicitly a reminder carrying the NEW expiry — from the registry
// hello@ sender.

vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

/** The expiry the database answers for the renewed row (a made-up date). */
const RENEWED_EXPIRY = '2026-06-03T18:00:00.000Z';

function makeStub() {
  return makeSupabaseStub({
    'organization_invites.select': {
      data: {
        id: 'invite-1',
        email: 'theo@north.example',
        role: 'staff',
        token: 'tokHvwVujKf',
        accepted_at: null,
        organizations: { name: 'L4L North Region' },
      },
      error: null,
    },
    // The renewed row the update asks back.
    'organization_invites.update': {
      data: { id: 'invite-1', expires_at: RENEWED_EXPIRY },
      error: null,
    },
    'user_profiles.select': {
      data: { full_name: 'Carsten Hartley Fowler', email: 'carsten@north.example' },
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
    expect(msg.to).toBe('theo@north.example');
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
          email: 'theo@north.example',
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

describe('TeamService.resendInvite — only a renewed invite is resent (S11-A)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads only an invite that is not revoked, and asks the renewed row back', async () => {
    const stub = makeStub();
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await svc.resendInvite('invite-1');

    const read = stub.chains.get('organization_invites.select')!;
    const readArgs = stub.chainArgs.get('organization_invites.select')!;
    expect(read[read.indexOf('is')]).toBe('is');
    expect(readArgs[read.indexOf('is')]).toEqual(['revoked_at', null]);

    const write = stub.chains.get('organization_invites.update')!;
    const writeArgs = stub.chainArgs.get('organization_invites.update')!;
    // (maybeSingle ends the chain; the stub records the methods before it.)
    expect(write).toEqual(['update', 'eq', 'eq', 'select']);
    expect(writeArgs[1]).toEqual(['organization_id', expect.any(String)]);
    expect(writeArgs[2]).toEqual(['id', 'invite-1']);
    expect(writeArgs[3]).toEqual(['id, expires_at']);
  });

  it('states the expiry the database renewed the invite to', async () => {
    const stub = makeStub();
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await svc.resendInvite('invite-1');
    const msg = vi.mocked(sendEmail).mock.calls[0]![0] as { html: string; text?: string };
    // RENEWED_EXPIRY in the invite emails' date format ("Wed, Jun 3", UTC).
    expect(msg.html).toContain('Wed, Jun 3');
  });

  it('when the update renews no row, refuses before the email and the audit entry', async () => {
    const stub = makeSupabaseStub({
      'organization_invites.select': {
        data: {
          id: 'invite-1',
          email: 'theo@north.example',
          role: 'staff',
          token: 'tokHvwVujKf',
          accepted_at: null,
          organizations: { name: 'L4L North Region' },
        },
        error: null,
      },
      // The database renewed nothing: the invite was revoked or accepted in
      // the meantime, or the caller is not an admin of the organization.
      'organization_invites.update': { data: null, error: null },
      'user_profiles.select': {
        data: { full_name: 'Carsten Hartley Fowler', email: 'carsten@north.example' },
        error: null,
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'This invite can no longer be resent. Send a new invite.',
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a revoked invite reads as not found, and nothing is written or sent', async () => {
    const stub = makeSupabaseStub({
      // The read filters revoked_at is null, so a revoked invite comes back empty.
      'organization_invites.select': { data: null, error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));
    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.chains.get('organization_invites.update')).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
