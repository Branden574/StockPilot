// apps/web/src/server/services/team.remove-member-sessions.test.ts
//
// Removing a member from ONE org must not evict that user from the orgs they
// are still a member of.
//
// `removeMember` used to call `admin.auth.admin.signOut(userId, 'global')`,
// which could never work (auth-js's signOut takes a JWT, not a uuid), so the
// revocation was a permanent no-op and the "we accept the collateral sign-out
// (rare)" comment above it described an intent that never actually executed.
// Replacing it with the real `revokeAllSessionsForUser` made that dormant
// collateral live: a GoTrue session belongs to a USER, not to an org, so one
// org admin pressing Remove deleted every auth.sessions row the user had and
// broadcast `{keepId: null}`, signing them out of every OTHER tenant, on every
// device, mid-task.
//
// These pin the scoping rule: revoke only when this org was the user's LAST
// one. See the comment on the call site for why nothing narrower is possible
// and why nothing is lost by skipping it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

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
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const REMOVED_USER = '33333333-3333-3333-3333-333333333333';
const MEMBER_ROW_ID = 'member-row-1';

/** The acting admin's own membership (assertRoleUnchanged) and the target row
 *  share one stub key, so one row has to satisfy both: role 'admin' matches the
 *  actor's ctx.role and is neither 'owner' nor the actor's own user id. */
function makeCtxStub() {
  return makeSupabaseStub({
    'organization_members.select': {
      data: { role: 'admin', user_id: REMOVED_USER },
      error: null,
    },
    'organization_members.delete': { data: null, error: null },
  });
}

/** `otherMemberships` is what the admin client reports for the removed user's
 *  remaining accepted memberships in OTHER orgs. */
function armAdmin(otherMemberships: Array<{ organization_id: string }>) {
  const stub = makeSupabaseStub({
    'warehouses.select': { data: [], error: null },
    'organization_members.select': { data: otherMemberships, error: null },
  });
  h.adminClient = stub.client;
  return stub;
}

function service() {
  const ctx = makeCtxStub();
  return {
    ctx,
    svc: new TeamService(makeServiceContext(ctx.client, { role: 'admin', organizationId: ORG })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s-1'] });
});

describe('TeamService.removeMember — session revocation scope', () => {
  it('revokes when this org was the removed user’s only membership', async () => {
    armAdmin([]);
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    expect(h.revoke).toHaveBeenCalledWith(REMOVED_USER);
  });

  it('does NOT revoke when the removed user still belongs to another org', async () => {
    armAdmin([{ organization_id: OTHER_ORG }]);
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('asks only about ACCEPTED memberships in OTHER orgs, for this user', async () => {
    const admin = armAdmin([]);
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    const args = admin.chainArgs.get('organization_members.select') ?? [];
    const flat = args.flat();
    expect(flat).toContain(REMOVED_USER);
    // Scoped away from the org we just removed them from, so the row we
    // deleted (or a replication lag on it) can never look like "belongs
    // elsewhere" and suppress a revocation that should happen.
    expect(flat).toContain(ORG);
    const methods = admin.chains.get('organization_members.select') ?? [];
    expect(methods).toContain('neq');
    expect(methods).toContain('not'); // accepted_at is not null
  });

  it('records the skip in the audit trail rather than reporting a revocation', async () => {
    armAdmin([{ organization_id: OTHER_ORG }]);
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    const removal = h.audit.mock.calls.find(
      (c) => (c[0] as { event: string }).event === 'user.deactivated',
    );
    const extra = (removal?.[0] as { extra: Record<string, unknown> }).extra;
    expect(extra.session_revoked).toBe(false);
    expect(extra.sessions_revoked_count).toBe(0);
    // The reason must be legible: "false" alone reads as a failed revoke.
    expect(extra.session_revoke_skipped).toBe('user_belongs_to_other_orgs');
    // And no session-invalidated row, because no session was invalidated.
    expect(
      h.audit.mock.calls.some((c) => (c[0] as { event: string }).event === 'user.session.invalidated'),
    ).toBe(false);
  });

  it('still audits a real revocation as one', async () => {
    armAdmin([]);
    h.revoke.mockResolvedValue({ ok: true, sessionIds: ['s-1', 's-2'] });
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    const removal = h.audit.mock.calls.find(
      (c) => (c[0] as { event: string }).event === 'user.deactivated',
    );
    const extra = (removal?.[0] as { extra: Record<string, unknown> }).extra;
    expect(extra.session_revoked).toBe(true);
    expect(extra.sessions_revoked_count).toBe(2);
    expect(extra.session_revoke_skipped).toBeNull();
  });

  it('revokes when the remaining-membership probe fails, rather than assuming safety', async () => {
    const stub = makeSupabaseStub({
      'warehouses.select': { data: [], error: null },
      'organization_members.select': { data: null, error: { message: 'boom' } },
    });
    h.adminClient = stub.client;
    const { svc } = service();

    await svc.removeMember(MEMBER_ROW_ID);

    // An unreadable probe must not silently suppress the revoke: the removal
    // is the security event, the collateral is the tolerable one.
    expect(h.revoke).toHaveBeenCalledWith(REMOVED_USER);
  });
});
