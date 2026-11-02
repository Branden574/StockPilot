// apps/web/src/server/services/team.withdrawn-invite.test.ts
//
// B94 review: a withdrawn invitation (revoked_at set) is terminal in the app,
// not only in the database row. Removing a member (migration 0429) and
// deleting an account (0393) withdraw the invitations the person sent: they
// set revoked_at and move expires_at into the past. Before this, no app path
// read revoked_at, so:
//   - Resend from a Team page loaded before the removal renewed expires_at
//     and the invitation could be accepted again (with the role and
//     warehouse the removed member chose);
//   - accept checked only accepted_at and expires_at, so a withdrawn row
//     with a future expiry (one Resend had renewed) was accepted;
//   - Pending invites and the "an active invite already exists" check
//     counted such a row as live.
//
// The stubs answer like PostgREST: a select returns only the columns the
// query names (so a check on a column the query never read fails here, as it
// would in production) and applies its own eq/is/gt filters.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

import { sendEmail } from '@/lib/email/resend';
import { createAdminClient } from '@/lib/supabase/admin';

import { acceptInviteWithToken, TeamService } from './team';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}));
vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));

const ORG = 'org-test';
const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 3 * DAY).toISOString();
const past = () => new Date(Date.now() - 60 * 1000).toISOString();
const withdrawnAt = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

type Row = Record<string, unknown>;

/** The names a select string reads ("a, b, alias:fk (cols)" -> a, b, alias). */
function selectedNames(call: MockCall): string[] | null {
  const cols = callArgs(call, 'select')?.[0];
  if (typeof cols !== 'string' || cols.trim() === '*') return null;
  return cols
    .split(',')
    .map((part) => part.trim().split(/[:(\s]/)[0]!)
    .filter((name) => name.length > 0);
}

/** servedLikePostgrest, then only the columns the query named. */
function selectedLikePostgrest(rows: () => Row[]): (call: MockCall) => QueryResult {
  const served = servedLikePostgrest(rows);
  return (call) => {
    const result = served(call);
    const names = selectedNames(call);
    if (!names) return result;
    const project = (r: Row) =>
      Object.fromEntries(names.filter((n) => n in r).map((n) => [n, r[n]]));
    return { ...result, data: (result.data as Row[]).map(project) };
  };
}

/** An update answered like PostgREST: its eq/is filters pick the rows it
 *  changes, and `.select()` returns them. */
function updatedLikePostgrest(rows: () => Row[]): (call: MockCall) => QueryResult {
  return (call) => {
    let out = [...rows()];
    call.methods.forEach((method, i) => {
      const [col, value] = (call.args[i] ?? []) as [string, unknown];
      if (method === 'eq') out = out.filter((r) => r[col] === value);
      else if (method === 'is') out = out.filter((r) => (r[col] ?? null) === value);
      else if (method !== 'update' && method !== 'select') {
        throw new Error(`updatedLikePostgrest cannot evaluate .${method}()`);
      }
    });
    return { data: call.methods.includes('select') ? out.map((r) => ({ id: r.id })) : null, error: null };
  };
}

function inviteRow(overrides: Row = {}): Row {
  return {
    id: 'invite-1',
    organization_id: ORG,
    email: 'new.person@example.test',
    role: 'staff',
    token: 'invite-ref-0000000001',
    expires_at: future(),
    accepted_at: null,
    revoked_at: null,
    warehouse_id: null,
    charter_id: null,
    charter_ids: null,
    all_warehouses: false,
    invited_by: 'removed-admin',
    created_at: new Date(Date.now() - 2 * DAY).toISOString(),
    organizations: { name: 'Example Workspace' },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('TeamService.resendInvite: a withdrawn invitation stays withdrawn', () => {
  function resendStub(readRows: () => Row[], writeRows: () => Row[] = readRows) {
    return makeSupabaseStub({
      'organization_invites.select': selectedLikePostgrest(readRows),
      'organization_invites.update': updatedLikePostgrest(writeRows),
      'user_profiles.select': {
        data: { full_name: 'Pat Example', email: 'pat@example.test' },
        error: null,
      },
    });
  }

  it('refuses one withdrawn by a removal, on a Team page loaded before it (expiry already past)', async () => {
    const rows = [inviteRow({ revoked_at: withdrawnAt(), expires_at: past() })];
    const stub = resendStub(() => rows);
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(stub.chainsAll.get('organization_invites.update') ?? []).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses one withdrawn whose expiry an earlier Resend renewed', async () => {
    const rows = [inviteRow({ revoked_at: withdrawnAt(), expires_at: future() })];
    const stub = resendStub(() => rows);
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(stub.chainsAll.get('organization_invites.update') ?? []).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses one withdrawn between its read and its write, and sends nothing', async () => {
    const live = [inviteRow()];
    const withdrawn = [inviteRow({ revoked_at: withdrawnAt(), expires_at: past() })];
    const stub = resendStub(
      () => live,
      () => withdrawn,
    );
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.resendInvite('invite-1')).rejects.toMatchObject({ code: 'conflict' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still resends a live one: the write is limited to a row not accepted and not withdrawn', async () => {
    const rows = [inviteRow()];
    const stub = resendStub(() => rows);
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const { acceptUrl } = await svc.resendInvite('invite-1');

    expect(acceptUrl).toContain('/i/invite-ref-0000000001');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const methods = stub.chains.get('organization_invites.update') ?? [];
    const args = stub.chainArgs.get('organization_invites.update') ?? [];
    const filters = methods.map((m, i) => [m, ...(args[i] ?? [])]);
    expect(filters).toContainEqual(['is', 'revoked_at', null]);
    expect(filters).toContainEqual(['is', 'accepted_at', null]);
  });
});

describe('acceptInviteWithToken: a withdrawn invitation cannot be accepted', () => {
  it('refuses a withdrawn row with a future expiry and creates no membership', async () => {
    const rows = [inviteRow({ revoked_at: withdrawnAt(), expires_at: future() })];
    const stub = makeSupabaseStub({
      'organization_invites.select': selectedLikePostgrest(() => rows),
      'organization_invites.update': { data: null, error: null },
      'user_profiles.select': {
        data: [{ email: 'new.person@example.test', default_organization_id: ORG }],
        error: null,
      },
      'user_warehouse_assignments.select': { data: null, error: null },
    });
    vi.mocked(createAdminClient).mockReturnValue(stub.client);

    await expect(acceptInviteWithToken('invite-ref-0000000001', 'invitee-1')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).not.toContain('organization_members');
  });
});

describe('Pending invites and the active-invite check skip a withdrawn invitation', () => {
  it('listPendingInvites leaves out a withdrawn row with a future expiry', async () => {
    const rows = [
      inviteRow({ id: 'live', email: 'live@example.test' }),
      inviteRow({ id: 'withdrawn', email: 'gone@example.test', revoked_at: withdrawnAt() }),
    ];
    const stub = makeSupabaseStub({
      'organization_invites.select': selectedLikePostgrest(() => rows),
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const list = await svc.listPendingInvites();

    expect(list.map((r) => r.id)).toEqual(['live']);
  });

  it('invite() sends a new invitation to an address whose only open-looking row was withdrawn', async () => {
    const rows = [
      inviteRow({ email: 'new.person@example.test', revoked_at: withdrawnAt(), expires_at: future() }),
    ];
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: null },
      'organization_members.select': { data: null, error: null },
      'organization_invites.select': selectedLikePostgrest(() => rows),
      'organization_invites.insert': { data: [{ id: 'invite-2', token: 'tok' }], error: null },
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.invite({
      email: 'new.person@example.test',
      role: 'viewer',
      organizationName: 'Example Workspace',
      inviterName: 'Pat Example',
      allWarehouses: true,
    });

    expect(stub.chainsAll.get('organization_invites.insert') ?? []).toHaveLength(1);
  });
});
