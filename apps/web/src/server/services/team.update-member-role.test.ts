// A member's role change: one update, one audit row, one security event; and
// a save of the role the member already has changes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

const h = vi.hoisted(() => ({
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  dispatchEvent: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/server/services/audit', () => ({
  audit: (...a: unknown[]) => h.audit(...a),
  insertAuditRowReported: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/integration-events', () => ({
  dispatchEvent: (...a: unknown[]) => h.dispatchEvent(...a),
}));
vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({ ok: true, sessionIds: [] })),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => null }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: 't' })) }));

import { TeamService } from './team';

const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const TARGET_USER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';

/**
 * organization_members answers two reads: the actor's own role
 * (assertRoleUnchanged selects 'role') and the target row ('user_id, role').
 */
function world(target: { role: string; user_id?: string } | null, actorRole = 'admin') {
  return makeSupabaseStub({
    'organization_members.select': (call: MockCall) =>
      callArgs(call, 'select')?.[0] === 'role'
        ? { data: { role: actorRole }, error: null }
        : {
            data: target ? { user_id: target.user_id ?? TARGET_USER, role: target.role } : null,
            error: null,
          },
    'organization_members.update': { data: { id: MEMBER }, error: null },
  });
}

function service(
  stub: ReturnType<typeof makeSupabaseStub>,
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  const ctx = makeServiceContext(stub.client, {
    role: 'admin',
    organizationId: ORG,
    userId: ACTOR,
    ...over,
  });
  return { ctx, svc: new TeamService(ctx as never) };
}

const updates = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainArgsAll.get('organization_members.update') ?? [];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TeamService.updateMemberRole', () => {
  it('a new role is one update, one audit row with the old and new role, and one security event', async () => {
    const stub = world({ role: 'staff' });
    const { ctx, svc } = service(stub);

    await svc.updateMemberRole(MEMBER, 'manager');

    expect(updates(stub)).toHaveLength(1);
    expect(updates(stub)[0]![0]).toEqual([{ role: 'manager' }]);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      {
        event: 'user.role.changed',
        entityType: 'organization_member',
        entityId: MEMBER,
        before: { role: 'staff' },
        after: { role: 'manager' },
      },
      ctx,
    );
    expect(h.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(h.dispatchEvent).toHaveBeenCalledWith(ORG, 'security.member_role_changed', {
      from: 'staff',
      to: 'manager',
    });
  });

  it.each(['admin', 'manager', 'staff', 'viewer'] as const)(
    'a save of the role the member already has (%s) changes nothing: no update, no audit row, no event',
    async (role) => {
      const stub = world({ role });
      const { svc } = service(stub);

      await expect(svc.updateMemberRole(MEMBER, role)).resolves.toBeUndefined();

      expect(updates(stub)).toHaveLength(0);
      expect(h.audit).not.toHaveBeenCalled();
      expect(h.dispatchEvent).not.toHaveBeenCalled();
    },
  );

  it('the same role is still refused without the permission', async () => {
    const stub = world({ role: 'staff' });
    const { svc } = service(stub, { role: 'manager' });

    await expect(svc.updateMemberRole(MEMBER, 'staff')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: members:update_role',
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('the same role is still refused while the authenticator code is owed', async () => {
    const stub = world({ role: 'staff' });
    const { svc } = service(stub, { mfaRequired: true, mfaSatisfied: false });

    await expect(svc.updateMemberRole(MEMBER, 'staff')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it("the same role is still refused on the caller's own row", async () => {
    const stub = world({ role: 'admin', user_id: ACTOR });
    const { svc } = service(stub);

    await expect(svc.updateMemberRole(MEMBER, 'admin')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'You cannot change your own role. Ask another admin.',
    });
    expect(updates(stub)).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('a member of another organization is not found, whatever the role', async () => {
    const stub = world(null);
    const { svc } = service(stub);

    await expect(svc.updateMemberRole(MEMBER, 'staff')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(updates(stub)).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.dispatchEvent).not.toHaveBeenCalled();
  });

  it('an update that matched no row is a conflict, with no audit row and no event', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': (call: MockCall) =>
        callArgs(call, 'select')?.[0] === 'role'
          ? { data: { role: 'admin' }, error: null }
          : { data: { user_id: TARGET_USER, role: 'staff' }, error: null },
      'organization_members.update': { data: null, error: null },
    });
    const { svc } = service(stub);

    await expect(svc.updateMemberRole(MEMBER, 'manager')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.dispatchEvent).not.toHaveBeenCalled();
  });
});
