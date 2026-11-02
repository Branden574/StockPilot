// apps/web/src/server/services/team.remove-member-zero-rows.test.ts
//
// B94: TeamService.removeMember read the delete's error and nothing else, so a
// delete that removed NO row was a success (recurring pattern #2): the row
// policy refused it (members:remove granted to someone below admin; the
// delete policy needs admin, 0140), or another admin removed the person a
// moment earlier. It then cleared the person's warehouse assignments and
// default organization, could revoke their sessions while they were still a
// member, and wrote user.deactivated. Now the delete returns the row it
// removed; with none, it re-reads the row to say which it was, before any
// side effect:
//   still there  forbidden "Only an owner or admin can remove a member."
//   gone         not_found "This member was already removed."
// And a removal that waited too long on a row the release (migration 0429)
// changes, or was a deadlock victim, is "Busy. Try again.", not an internal
// error: the delete and the release are one statement, so nothing was kept.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

const h = vi.hoisted(() => ({
  revoke: vi.fn(async (..._a: unknown[]) => ({ ok: true, sessionIds: ['s-1'] })),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  adminClient: null as unknown,
}));

vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...a: unknown[]) => h.revoke(...a),
}));
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.adminClient }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: 't' })) }));

import { TeamService } from './team';

const ORG = '11111111-1111-1111-1111-111111111111';
const REMOVED_USER = '33333333-3333-3333-3333-333333333333';
const MEMBER_ROW_ID = '44444444-4444-4444-4444-444444444444';

/**
 * The user client: the acting admin's own row (assertRoleUnchanged reads
 * `role`), the target row (`role, user_id`), and the re-read after a 0-row
 * delete (`id`), told apart by the columns each asks for.
 */
function makeCtx(opts: {
  delete: { data: unknown; error: { message: string; code?: string } | null };
  stillThere?: boolean;
}) {
  return makeSupabaseStub({
    'organization_members.select': (call: MockCall) => {
      const cols = callArgs(call, 'select')?.[0];
      if (cols === 'role') return { data: { role: 'admin' }, error: null };
      if (cols === 'role, user_id')
        return { data: { role: 'staff', user_id: REMOVED_USER }, error: null };
      if (cols === 'id')
        return { data: opts.stillThere ? { id: MEMBER_ROW_ID } : null, error: null };
      throw new Error(`unexpected organization_members select: ${String(cols)}`);
    },
    'organization_members.delete': opts.delete,
  });
}

function armAdmin() {
  const stub = makeSupabaseStub({
    'warehouses.select': { data: [{ id: 'wh-1' }], error: null },
    'user_warehouse_assignments.delete': { data: [{ warehouse_id: 'wh-1' }], error: null },
    'organization_members.select': { data: [], error: null },
  });
  h.adminClient = stub.client;
  return stub;
}

function service(ctx: ReturnType<typeof makeCtx>) {
  return new TeamService(makeServiceContext(ctx.client, { role: 'admin', organizationId: ORG }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s-1'] });
});

/** Nothing after the delete ran: no cleanup, no revoke, no audit row. */
function expectNoSideEffect(admin: ReturnType<typeof armAdmin>) {
  expect(admin.fromCalls).toEqual([]);
  expect(h.revoke).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
}

describe('TeamService.removeMember — a delete that removed no row', () => {
  it('asks the delete for the row it removed, scoped to this organization', async () => {
    const admin = armAdmin();
    const ctx = makeCtx({ delete: { data: [{ id: MEMBER_ROW_ID }], error: null } });

    await service(ctx).removeMember(MEMBER_ROW_ID);

    const methods = ctx.chains.get('organization_members.delete') ?? [];
    expect(methods).toEqual(['delete', 'eq', 'eq', 'select']);
    expect((ctx.chainArgs.get('organization_members.delete') ?? []).flat()).toEqual(
      expect.arrayContaining([ORG, MEMBER_ROW_ID, 'id']),
    );
    // One row removed: the rest of the removal runs as before.
    expect(admin.fromCalls).toContain('user_warehouse_assignments');
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user.deactivated', entityId: MEMBER_ROW_ID }),
      expect.anything(),
    );
  });

  it('is refused when the row is still there (the row policy refused the delete), with no side effect', async () => {
    const admin = armAdmin();
    const ctx = makeCtx({ delete: { data: [], error: null }, stillThere: true });

    await expect(service(ctx).removeMember(MEMBER_ROW_ID)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Only an owner or admin can remove a member.',
    });
    expectNoSideEffect(admin);
    // The re-read is the same row, in this organization.
    const reread = (ctx.chainArgsAll.get('organization_members.select') ?? []).find(
      (args) => args[0]?.[0] === 'id',
    );
    expect(reread?.flat()).toEqual(expect.arrayContaining([ORG, MEMBER_ROW_ID]));
  });

  it('says the member was already removed when the row is gone, with no side effect', async () => {
    const admin = armAdmin();
    const ctx = makeCtx({ delete: { data: [], error: null }, stillThere: false });

    await expect(service(ctx).removeMember(MEMBER_ROW_ID)).rejects.toMatchObject({
      code: 'not_found',
      message: 'This member was already removed.',
    });
    expectNoSideEffect(admin);
  });

  it('treats a delete that answers no rows at all (null) the same as an empty list', async () => {
    const admin = armAdmin();
    const ctx = makeCtx({ delete: { data: null, error: null }, stillThere: true });

    await expect(service(ctx).removeMember(MEMBER_ROW_ID)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expectNoSideEffect(admin);
  });
});

describe('TeamService.removeMember — busy', () => {
  it.each(['55P03', '57014', '40P01'])(
    'answers %s with "Busy. Try again." (conflict, retryable), with no side effect',
    async (code) => {
      const admin = armAdmin();
      const ctx = makeCtx({
        delete: { data: null, error: { message: 'canceling statement', code } },
      });

      await expect(service(ctx).removeMember(MEMBER_ROW_ID)).rejects.toMatchObject({
        code: 'conflict',
        message: 'Busy. Try again.',
        details: { reason: 'busy', retryable: true },
      });
      expectNoSideEffect(admin);
    },
  );

  it('any other delete error is still an internal error, with no side effect', async () => {
    const admin = armAdmin();
    const ctx = makeCtx({ delete: { data: null, error: { message: 'boom', code: 'XX000' } } });

    await expect(service(ctx).removeMember(MEMBER_ROW_ID)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expectNoSideEffect(admin);
  });
});
