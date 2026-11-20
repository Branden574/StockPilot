import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
} from '@/test/supabase-mock';

import { TeamService } from './team';

/**
 * S11-A: an invite that can still be used is one not accepted, not revoked
 * and not expired. Pending invites and invite()'s active-invite check read it
 * that way, so a revoked invite whose expiry is still ahead is neither listed
 * nor in the way of a new invite to the same address. (The Admin overview's
 * pending count is pinned in app/(dashboard)/dashboard/admin/page.test.tsx.)
 */

vi.mock('@/lib/email/resend', () => ({
  sendEmail: vi.fn(async () => ({ ok: true, id: 'test' })),
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  insertAuditRowReported: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

const DAY = 24 * 60 * 60 * 1000;
const inThreeDays = () => new Date(Date.now() + 3 * DAY).toISOString();
const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

type Row = Record<string, unknown>;

function inviteRow(overrides: Row = {}): Row {
  return {
    id: 'invite-1',
    organization_id: 'org-test',
    email: 'sam.example@example.test',
    role: 'staff',
    token: 'invite-ref-example-01',
    expires_at: inThreeDays(),
    accepted_at: null,
    revoked_at: null,
    created_at: new Date(Date.now() - 2 * DAY).toISOString(),
    ...overrides,
  };
}

/** servedLikePostgrest, keeping only what a select names (no embeds here). */
function selectedLikePostgrest(rows: () => Row[]): (call: MockCall) => QueryResult {
  const served = servedLikePostgrest(rows);
  return (call) => {
    const result = served(call);
    const cols = call.args[call.methods.indexOf('select')]?.[0];
    if (typeof cols !== 'string') return result;
    const names = cols.split(',').map((c) => c.trim());
    return {
      ...result,
      data: (result.data as Row[]).map((r) =>
        Object.fromEntries(names.filter((n) => n in r).map((n) => [n, r[n]])),
      ),
    };
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Pending invites leave out a revoked invite (S11-A)', () => {
  it('listPendingInvites lists an open invite and not a revoked one whose expiry is ahead', async () => {
    const rows = [
      inviteRow({ id: 'open', email: 'open.person@example.test' }),
      inviteRow({ id: 'revoked', email: 'revoked.person@example.test', revoked_at: anHourAgo() }),
    ];
    const stub = makeSupabaseStub({
      'organization_invites.select': selectedLikePostgrest(() => rows),
    });
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    const list = await svc.listPendingInvites();

    expect(list.map((r) => r.id)).toEqual(['open']);
  });
});

describe("invite()'s active-invite check skips a revoked invite (S11-A)", () => {
  function inviteStub(rows: Row[]) {
    return makeSupabaseStub({
      'user_profiles.select': { data: null, error: null },
      'organization_members.select': { data: null, error: null },
      'organization_invites.select': selectedLikePostgrest(() => rows),
      'organization_invites.insert': {
        data: { id: 'invite-2', token: 'invite-ref-example-02' },
        error: null,
      },
    });
  }

  const params = {
    email: 'sam.example@example.test',
    role: 'viewer' as const,
    organizationName: 'Example Workspace',
    inviterName: 'Jo Sample',
    allWarehouses: true,
  };

  it('a new invite goes out when the address only has a revoked invite with its expiry ahead', async () => {
    const stub = inviteStub([inviteRow({ revoked_at: anHourAgo() })]);
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await svc.invite(params);

    expect(stub.chainsAll.get('organization_invites.insert') ?? []).toHaveLength(1);
  });

  it('control: an open invite to the address still refuses a second one', async () => {
    const stub = inviteStub([inviteRow()]);
    const svc = new TeamService(makeServiceContext(stub.client, { role: 'admin' }));

    await expect(svc.invite(params)).rejects.toMatchObject({
      code: 'conflict',
      message: 'An active invite already exists for that email.',
    });
    expect(stub.chainsAll.get('organization_invites.insert') ?? []).toHaveLength(0);
  });
});
