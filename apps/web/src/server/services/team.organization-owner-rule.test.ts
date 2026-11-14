// apps/web/src/server/services/team.organization-owner-rule.test.ts
//
// Migration 0458: the database refuses, at commit, a change that would leave
// an organization with members and no owner (P0001 organization_needs_owner),
// and answers 55P03 organization_owner_check_busy while another change to the
// same organization's owners or members is being saved. The Team page's role
// change and member removal never send such a change (the service and the
// guard refuse an owner row first), so these answers come only from the
// database; when they do, the person reads a plain sentence, not the general
// error, and nothing is audited.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORGANIZATION_NEEDS_OWNER_COPY,
  ORGANIZATION_OWNER_BUSY_COPY,
} from '@/server/lib/organization-owner-rule';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const h = vi.hoisted(() => ({
  revoke: vi.fn(async (..._a: unknown[]) => ({ ok: true, sessionIds: [] })),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  dispatch: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: (...a: unknown[]) => h.revoke(...a),
}));
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ ok: true, id: 't' })) }));
vi.mock('./integration-events', () => ({
  dispatchEvent: (...a: unknown[]) => h.dispatch(...a),
}));

import { ServiceError } from './context';
import { TeamService } from './team';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '33333333-3333-3333-3333-333333333333';

/** One row answers the actor's own membership read (assertRoleUnchanged) and
 *  the target read: role 'admin' (the actor's ctx.role, not an owner), and a
 *  user id that is not the actor's. */
function service(write: 'update' | 'delete', error: { code: string; message: string }) {
  const stub = makeSupabaseStub({
    'organization_members.select': { data: { role: 'admin', user_id: OTHER_USER }, error: null },
    [`organization_members.${write}`]: { data: null, error },
  });
  return new TeamService(makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }));
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

beforeEach(() => vi.clearAllMocks());

describe.each([
  { name: 'updateMemberRole', write: 'update' as const, run: (s: TeamService) => s.updateMemberRole('m-1', 'viewer') },
  { name: 'removeMember', write: 'delete' as const, run: (s: TeamService) => s.removeMember('m-1') },
])('TeamService.$name: the organization keeps an owner (0458)', ({ write, run }) => {
  it('organization_needs_owner: a plain sentence, nothing audited', async () => {
    const e = await caught(run(service(write, { code: 'P0001', message: 'organization_needs_owner' })));
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe('conflict');
    expect((e as ServiceError).message).toBe(ORGANIZATION_NEEDS_OWNER_COPY);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('organization_owner_check_busy: try again in a minute, nothing audited', async () => {
    const e = await caught(run(service(write, { code: '55P03', message: 'organization_owner_check_busy' })));
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe('conflict');
    expect((e as ServiceError).message).toBe(ORGANIZATION_OWNER_BUSY_COPY);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('any other write failure stays the general error', async () => {
    const e = await caught(run(service(write, { code: '57014', message: 'canceling statement due to statement timeout' })));
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe('internal_error');
  });
});
