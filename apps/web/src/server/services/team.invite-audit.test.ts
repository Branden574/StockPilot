import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';

import { audit } from './audit';
import { TeamService } from './team';

/**
 * Sending an invitation and revoking one each leave one audit row: who did
 * it (the row's user), which invite (entity org_invite and its id), the
 * address and the role. A refused call or a failed write leaves none.
 */

vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

const INVITE_ID = '00000000-0000-4000-8000-0000000000a1';
const WAREHOUSE_ID = '00000000-0000-4000-8000-0000000000b1';
const CHARTER_ID = '00000000-0000-4000-8000-0000000000c1';

const INVITE_PARAMS = {
  email: '  Wren.Halloway@Example.test ',
  role: 'manager' as const,
  organizationName: 'Example Charter Group',
  inviterName: 'Odile Marchetti',
  allWarehouses: true,
};

/** invite(): nobody with this address, no pending invite, the insert succeeds. */
function newInviteStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'user_profiles.select': { data: null, error: null },
    'organization_members.select': { data: null, error: null },
    'organization_invites.select': { data: null, error: null },
    'organization_invites.insert': {
      data: { id: INVITE_ID, token: 'tokExampleOnly' },
      error: null,
    },
    ...overrides,
  });
}

/** revokeInvite(): the delete returns the invite of this organization. */
function revokeStub(result: { data: unknown; error: unknown }) {
  return makeSupabaseStub({ 'organization_invites.delete': result as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: 'test' } as never);
});

describe('TeamService.invite records the invitation', () => {
  it('writes one user.invited row with the invite, the address and the role', async () => {
    const stub = newInviteStub();
    const svc = new TeamService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: 'org-ex' }),
    );

    await svc.invite(INVITE_PARAMS);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      {
        event: 'user.invited',
        entityType: 'org_invite',
        entityId: INVITE_ID,
        after: {
          email: 'wren.halloway@example.test',
          role: 'manager',
          all_warehouses: true,
          warehouse_id: null,
          charter_ids: null,
          email_sent: true,
        },
      },
      expect.objectContaining({ organizationId: 'org-ex', userId: 'user-test' }),
    );
  });

  it('still records the invitation when the email could not be sent, and says so', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, error: '503 upstream' } as never);
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));

    await expect(svc.invite(INVITE_PARAMS)).rejects.toMatchObject({ code: 'conflict' });

    // The invite row exists and its link can be copied, so it is recorded;
    // email_sent keeps the row from claiming a message went out.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.invited',
        entityId: INVITE_ID,
        after: expect.objectContaining({ email_sent: false }),
      }),
      expect.anything(),
    );
  });

  it('records the warehouse and charters a scoped invitation offers', async () => {
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));

    await svc.invite({
      ...INVITE_PARAMS,
      role: 'staff',
      allWarehouses: false,
      warehouseId: WAREHOUSE_ID,
      charterIds: [CHARTER_ID],
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.invited',
        after: expect.objectContaining({
          role: 'staff',
          all_warehouses: false,
          warehouse_id: WAREHOUSE_ID,
          charter_ids: [CHARTER_ID],
        }),
      }),
      expect.anything(),
    );
  });

  it('still records the invitation when sending the email throws', async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error('socket closed'));
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'admin' }));

    await expect(svc.invite(INVITE_PARAMS)).rejects.toMatchObject({ code: 'conflict' });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.invited',
        entityId: INVITE_ID,
        after: expect.objectContaining({ email_sent: false }),
      }),
      expect.anything(),
    );
  });

  it('writes no row when the caller may not invite', async () => {
    const svc = new TeamService(makeServiceContext(newInviteStub().client, { role: 'staff' }));

    await expect(svc.invite(INVITE_PARAMS)).rejects.toMatchObject({ code: 'forbidden' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('writes no row when an active invite already exists for the address', async () => {
    const stub = newInviteStub({
      'organization_invites.select': { data: { id: 'invite-existing' }, error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.invite(INVITE_PARAMS)).rejects.toMatchObject({ code: 'conflict' });
    expect(audit).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('writes no row when the insert fails', async () => {
    const stub = newInviteStub({
      'organization_invites.insert': {
        data: null,
        error: { message: 'new row violates row-level security policy', code: '42501' },
      },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.invite(INVITE_PARAMS)).rejects.toMatchObject({ code: 'internal_error' });
    expect(audit).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('TeamService.revokeInvite records the revocation', () => {
  it('writes one user.invite.revoked row with the invite, the address and the role', async () => {
    const stub = revokeStub({
      data: { id: INVITE_ID, email: 'wren.halloway@example.test', role: 'viewer' },
      error: null,
    });
    const svc = new TeamService(
      makeServiceContext(stub.client, { role: 'admin', organizationId: 'org-ex' }),
    );

    await svc.revokeInvite(INVITE_ID);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      {
        event: 'user.invite.revoked',
        entityType: 'org_invite',
        entityId: INVITE_ID,
        before: { email: 'wren.halloway@example.test', role: 'viewer' },
      },
      expect.objectContaining({ organizationId: 'org-ex', userId: 'user-test' }),
    );
  });

  it('writes no row when no invite of this organization was deleted', async () => {
    const svc = new TeamService(
      makeServiceContext(revokeStub({ data: null, error: null }).client, { role: 'admin' }),
    );

    await expect(svc.revokeInvite(INVITE_ID)).rejects.toMatchObject({ code: 'not_found' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('writes no row when the delete fails', async () => {
    const stub = revokeStub({
      data: null,
      error: { message: 'permission denied for table organization_invites', code: '42501' },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.revokeInvite(INVITE_ID)).rejects.toMatchObject({ code: 'internal_error' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('writes no row when the caller may not revoke', async () => {
    const stub = revokeStub({
      data: { id: INVITE_ID, email: 'wren.halloway@example.test', role: 'viewer' },
      error: null,
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'manager' }));

    await expect(svc.revokeInvite(INVITE_ID)).rejects.toMatchObject({ code: 'forbidden' });
    expect(audit).not.toHaveBeenCalled();
  });
});
