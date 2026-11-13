// apps/web/src/server/services/team.accept-invite-existing-member.test.ts
//
// acceptInviteWithToken reads the person's membership of the invite's
// organization before it writes anything:
//   - an ACCEPTED membership is left exactly as it is (role, flags, warehouse
//     access, default organization); the invite is marked used and the result
//     says the person is already a member;
//   - a membership row that is not accepted yet is completed as before;
//   - no membership row: the membership is created as before;
//   - a failed membership read refuses the acceptance and writes nothing.
//
// The admin client is mocked via `@/lib/supabase/admin`. setup.ts mocks
// `@/server/services/audit`: audit() is a no-op spy and insertAuditRowReported
// hands its row to the mocked admin client (audit_logs.insert).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { audit } from '@/server/services/audit';
import { makeSupabaseStub, type MockCall, type SupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { acceptInviteWithToken } from './team';

import { createAdminClient } from '@/lib/supabase/admin';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));

const ORG = 'org-1';
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WH1 = '11111111-1111-1111-1111-111111111111';
const WH2 = '22222222-2222-2222-2222-222222222222';
const EMAIL = 'member.person@example.test';

const futureIso = () => new Date(Date.now() + 86_400_000).toISOString();

function inviteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    organization_id: ORG,
    email: EMAIL,
    role: 'viewer',
    expires_at: futureIso(),
    accepted_at: null,
    warehouse_id: WH1,
    charter_id: null,
    charter_ids: null,
    all_warehouses: false,
    invited_by: 'inviter-1',
    ...overrides,
  };
}

type MembershipRead =
  | { row: { id: string; role: string; accepted_at: string | null } | null }
  | { error: { message: string } };

/**
 * One admin-client stub for the whole accept path. The membership read is
 * answered only when it asks for this organization and this person, so a
 * read that forgets either filter finds nothing.
 */
function stubFor(invite: Record<string, unknown>, membership: MembershipRead): SupabaseStub {
  const stub = makeSupabaseStub({
    'organization_invites.select': { data: [invite], error: null },
    'organization_invites.update': { data: null, error: null },
    // Serves the email match and the default-organization read. No default
    // organization yet, so the path that sets one is reachable.
    'user_profiles.select': {
      data: [{ email: EMAIL, default_organization_id: null }],
      error: null,
    },
    'user_profiles.update': { data: null, error: null },
    'organization_members.select': (call: MockCall) => {
      if ('error' in membership) return { data: null, error: membership.error };
      const filters = call.methods
        .map((m, i) => (m === 'eq' ? (call.args[i] as [string, unknown]) : null))
        .filter((f): f is [string, unknown] => f !== null);
      const asksOrg = filters.some(([c, v]) => c === 'organization_id' && v === ORG);
      const asksUser = filters.some(([c, v]) => c === 'user_id' && v === USER);
      return { data: asksOrg && asksUser && membership.row ? [membership.row] : [], error: null };
    },
    'organization_members.insert': { data: null, error: null },
    'organization_members.update': { data: null, error: null },
    'warehouses.select': { data: [{ id: WH1 }, { id: WH2 }], error: null },
    'user_warehouse_assignments.select': { data: null, error: null },
    'user_warehouse_assignments.insert': { data: null, error: null },
    'audit_logs.insert': { data: null, error: null },
  });
  vi.mocked(createAdminClient).mockReturnValue(stub.client);
  return stub;
}

/** Every write chain recorded against a table: insert/upsert, update, delete. */
function writesTo(stub: SupabaseStub, table: string) {
  return ['insert', 'update', 'delete'].flatMap((op) => stub.chainsAll.get(`${table}.${op}`) ?? []);
}

function inviteUpdates(stub: SupabaseStub) {
  return (stub.chainArgsAll.get('organization_invites.update') ?? []).map(
    (args) => args[0]?.[0] as Record<string, unknown>,
  );
}

function auditRows(stub: SupabaseStub) {
  return (stub.chainArgsAll.get('audit_logs.insert') ?? []).map(
    (args) => args[0]?.[0] as Record<string, unknown>,
  );
}

describe('acceptInviteWithToken: the person is already an accepted member', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['owner', inviteRow({ role: 'viewer', warehouse_id: WH1 })],
    ['admin', inviteRow({ role: 'viewer', warehouse_id: null, all_warehouses: true })],
  ])(
    'leaves an accepted %s membership as it is and marks the invite used',
    async (existingRole, invite) => {
      const stub = stubFor(invite, {
        row: { id: 'member-1', role: existingRole, accepted_at: '2026-01-02T03:04:05.000Z' },
      });

      const result = await acceptInviteWithToken('tok', USER);

      // Nothing about the membership, the warehouse access or the profile.
      expect(writesTo(stub, 'organization_members')).toEqual([]);
      expect(writesTo(stub, 'user_warehouse_assignments')).toEqual([]);
      expect(writesTo(stub, 'user_profiles')).toEqual([]);
      expect(vi.mocked(audit)).not.toHaveBeenCalled();

      expect(result).toEqual({ organizationId: ORG, alreadyMember: true });

      // The invite is used, so the link cannot be pressed again.
      const updates = inviteUpdates(stub);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({ accepted_at: expect.any(String) });
      const updateArgs = stub.chainArgs.get('organization_invites.update') ?? [];
      expect(updateArgs).toContainEqual(['id', 'invite-1']);

      // The record says the invite was closed for an existing member and
      // that the role stayed; it never claims the invite's role was given.
      const rows = auditRows(stub);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organization_id: ORG,
        user_id: USER,
        event: 'user.invite.accepted',
        metadata: {
          invite_id: 'invite-1',
          already_member: true,
          invite_role: 'viewer',
          member_role: existingRole,
        },
      });
      expect((rows[0]?.metadata as Record<string, unknown>).role).toBeUndefined();
    },
  );
});

describe('acceptInviteWithToken: everyone else', () => {
  beforeEach(() => vi.clearAllMocks());

  it('completes a membership row that is not accepted yet, as before', async () => {
    const stub = stubFor(inviteRow({ role: 'staff' }), {
      row: { id: 'member-1', role: 'viewer', accepted_at: null },
    });

    const result = await acceptInviteWithToken('tok', USER);

    expect(result).toEqual({ organizationId: ORG, alreadyMember: false });
    const upserts = stub.chainArgsAll.get('organization_members.insert') ?? [];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[0]).toEqual([
      {
        organization_id: ORG,
        user_id: USER,
        role: 'staff',
        invited_by: 'inviter-1',
        accepted_at: expect.any(String),
      },
      { onConflict: 'organization_id,user_id' },
    ]);
    expect(stub.chainArgsAll.get('user_warehouse_assignments.insert') ?? []).toHaveLength(1);
    expect(inviteUpdates(stub)).toEqual([{ accepted_at: expect.any(String) }]);
    expect(auditRows(stub)[0]).toMatchObject({
      event: 'user.invite.accepted',
      metadata: { invite_id: 'invite-1', role: 'staff' },
    });
  });

  it('creates the membership when there is none, writing what it wrote before', async () => {
    const stub = stubFor(inviteRow({ role: 'viewer', warehouse_id: null, all_warehouses: true }), {
      row: null,
    });

    const result = await acceptInviteWithToken('tok', USER);

    expect(result).toEqual({ organizationId: ORG, alreadyMember: false });
    const upserts = stub.chainArgsAll.get('organization_members.insert') ?? [];
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.[0]).toEqual([
      {
        organization_id: ORG,
        user_id: USER,
        role: 'viewer',
        invited_by: 'inviter-1',
        accepted_at: expect.any(String),
        all_warehouses: true,
      },
      { onConflict: 'organization_id,user_id' },
    ]);
    expect(stub.chainArgsAll.get('user_warehouse_assignments.insert') ?? []).toHaveLength(2);
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(inviteUpdates(stub)).toEqual([{ accepted_at: expect.any(String) }]);
    // No default organization yet, so this one becomes it.
    const profileUpdates = (stub.chainArgsAll.get('user_profiles.update') ?? []).map(
      (args) => args[0]?.[0],
    );
    expect(profileUpdates).toEqual([{ default_organization_id: ORG }]);
    expect(auditRows(stub)).toEqual([
      {
        organization_id: ORG,
        user_id: USER,
        event: 'user.invite.accepted',
        metadata: {
          invite_id: 'invite-1',
          role: 'viewer',
          warehouse_id: null,
          charter_id: null,
          charter_ids: [null],
          all_warehouses: true,
        },
      },
    ]);
  });

  it('refuses when the membership cannot be read, and writes nothing', async () => {
    const stub = stubFor(inviteRow(), { error: { message: 'connection reset' } });

    const outcome = await acceptInviteWithToken('tok', USER).then(
      () => null,
      (e: unknown) => e,
    );

    expect(outcome).toBeInstanceOf(ServiceError);
    expect((outcome as ServiceError).code).toBe('internal_error');
    expect(writesTo(stub, 'organization_members')).toEqual([]);
    expect(writesTo(stub, 'user_warehouse_assignments')).toEqual([]);
    expect(writesTo(stub, 'organization_invites')).toEqual([]);
    expect(writesTo(stub, 'user_profiles')).toEqual([]);
    expect(writesTo(stub, 'audit_logs')).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
