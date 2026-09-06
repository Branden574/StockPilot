import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';

import { TeamService } from './team';
import { audit } from './audit';

/**
 * "Invite sent" must never be said when nothing was sent.
 *
 * sendEmail NEVER throws — a non-2xx from Resend or a network failure comes
 * back as `{ ok: false, error }` (lib/email/resend.ts). Both invite() and
 * resendInvite() discarded that value, so an admin saw a success toast, the
 * audit log recorded 'user.invited', and the person was never contacted. The
 * 2026-07-02 mailer incident is exactly this failure mode reaching production
 * silently, which is why the result is now checked BEFORE the audit row.
 */

vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

/** invite(): no existing invite for this address, insert succeeds. */
function newInviteStub() {
  return makeSupabaseStub({
    'organization_invites.select': { data: null, error: null },
    'organization_invites.insert': {
      data: { id: 'invite-1', token: 'tokHvwVujKf', email: 'theo@l4lnorth.com' },
      error: null,
    },
    'organization_members.select': { data: null, error: null },
    'user_profiles.select': {
      data: { full_name: 'Branden Vincent Walker', email: 'branden@l4lnorth.com' },
      error: null,
    },
  });
}

/** resendInvite(): the pending invite exists. */
function existingInviteStub() {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: 'test' } as never);
});

describe('TeamService.invite — a failed send is not a success', () => {
  it('throws instead of returning an accept URL when Resend refuses', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: '429 rate limited' } as never);
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));
    await expect(
      svc.invite({
        email: 'theo@l4lnorth.com',
        role: 'viewer',
        organizationName: 'L4L North Region',
        inviterName: 'Branden',
        allWarehouses: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('tells the admin how to finish the job themselves', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: 'boom' } as never);
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));
    await expect(
      svc.invite({
        email: 'theo@l4lnorth.com',
        role: 'viewer',
        organizationName: 'L4L North Region',
        inviterName: 'Branden',
        allWarehouses: true,
      }),
      // A refusal with no way forward is a support ticket. `internal_error`
      // would have genericised this message away (S13), so the code matters.
    ).rejects.toThrow(/Pending invites|Resend/i);
  });

  it('still succeeds on a good send', async () => {
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));
    const out = await svc.invite({
      email: 'theo@l4lnorth.com',
      role: 'viewer',
      organizationName: 'L4L North Region',
      inviterName: 'Branden',
      allWarehouses: true,
    });
    expect(out.acceptUrl).toMatch(/\/i\/[A-Za-z0-9_-]+$/);
  });
});

describe('TeamService.resendInvite — no audit row for a send that did not happen', () => {
  it('throws and writes NO audit row when the resend fails', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: '500 upstream' } as never);
    const svc = new TeamService(makeServiceContext(existingInviteStub().client, { role: 'admin' }));
    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({
      code: 'conflict',
    });
    // The claim 'user.invited resent:true' must not outlive the send.
    expect(audit).not.toHaveBeenCalled();
  });

  it('audits only a real send', async () => {
    const svc = new TeamService(makeServiceContext(existingInviteStub().client, { role: 'admin' }));
    await svc.resendInvite('invite-1');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.invited', after: expect.objectContaining({ resent: true }) }),
      expect.anything(),
    );
  });
});
