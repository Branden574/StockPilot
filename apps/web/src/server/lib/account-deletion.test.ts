import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportErrorMock, insertAuditRowReportedMock } = vi.hoisted(() => ({
  reportErrorMock: vi.fn(async () => undefined),
  insertAuditRowReportedMock: vi.fn(async (_row: Record<string, unknown>) => true),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));
vi.mock('@/server/services/audit', () => ({ insertAuditRowReported: insertAuditRowReportedMock }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'UA/1' })),
}));

import {
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_SIGNED_OUT_COPY,
  auditAccountDeleted,
  checkAccountDeletable,
  lastOwnerCopy,
  lateLastOwnerRefusal,
  readDeletionReviewFacts,
  removeAvatarObjects,
  reportDeletionReviewFacts,
  settleFailedDelete,
  soleOwnedOrganizationsWithMembers,
} from './account-deletion';
import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * The server's question before it deletes an account (migration 0388):
 * account_deletion_check dry-runs the real delete and always undoes it. Every
 * answer but "deletable" must make the caller change nothing, so the mapping
 * from the function's JSON to the four refusal kinds is pinned here.
 */
function adminAnswering(res: { data: unknown; error: { code?: string } | null } | Error) {
  const rpc = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  return { admin: { rpc } as never, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkAccountDeletable', () => {
  it('asks account_deletion_check with the user id, and deletable is ok', async () => {
    const { admin, rpc } = adminAnswering({ data: { deletable: true }, error: null });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('account_deletion_check', { p_user_id: 'u-1' });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  // Re-pinned by 0393 (was reported at info: "expected for linked
  // records"): 0393 converted every refusing business key, so an integrity
  // refusal now is a record the census missed, reported as a warning.
  it('an integrity refusal is blocked, with the constraint and table (reported as a warning since 0393, names only)', async () => {
    const { admin } = adminAnswering({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: '23503',
        constraint: 'po_imports_uploaded_by_fkey',
        table: 'public.po_imports',
      },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'mobile')).resolves.toEqual({
      ok: false,
      kind: 'blocked',
      sqlstate: '23503',
      constraint: 'po_imports_uploaded_by_fkey',
      table: 'public.po_imports',
    });
    expect(reportErrorMock).toHaveBeenCalledWith(expect.anything(), {
      tag: 'account.delete.blocked',
      level: 'warning',
      extra: {
        source: 'mobile',
        sqlstate: '23503',
        constraint: 'po_imports_uploaded_by_fkey',
        table: 'public.po_imports',
      },
    });
  });

  // 0393: the account trigger's one refusal (P0001 is not class 23, so it
  // must be read by its constraint before the class-23 rule).
  it('the last-owner refusal (P0001, organization_last_owner) is last_owner, reported at info', async () => {
    const { admin } = adminAnswering({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: 'P0001',
        constraint: 'organization_last_owner',
        table: 'public.organization_members',
      },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'last_owner',
      sqlstate: 'P0001',
      constraint: 'organization_last_owner',
      table: 'public.organization_members',
    });
    expect(reportErrorMock).toHaveBeenCalledWith(expect.anything(), {
      tag: 'account.delete.last_owner',
      level: 'info',
      extra: { source: 'web', sqlstate: 'P0001' },
    });
  });

  it('a P0001 from anything else is still a check failure (never last_owner, never blocked)', async () => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate: 'P0001', constraint: null, table: null },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
      sqlstate: 'P0001',
    });
  });

  it('a NOT NULL refusal with no constraint name is still blocked (the generic path)', async () => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate: '23502', constraint: null, table: 'public.platform_admin_audit' },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'blocked',
      sqlstate: '23502',
      table: 'public.platform_admin_audit',
    });
  });

  it.each([['55P03'], ['40P01']])('a lock wait or a deadlock (%s) is retry, not blocked', async (sqlstate) => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate, constraint: null, table: null },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'retry',
      sqlstate,
    });
  });

  // Review R1 (2026-10-03): the SQL function returns EVERY error its
  // subtransaction catches as reason 'blocked'. Only an integrity refusal
  // (SQLSTATE class 23: a RESTRICT or NO ACTION key, a CHECK, a NOT NULL) is a
  // record the organization keeps. Anything else is the system failing (a
  // read-only transaction answered 25006 and a lost DELETE privilege 42501 in
  // rolled-back probes), which must say "try again" and be reported as an
  // error, never "linked to records" at info level.
  it.each([['23514'], ['23503'], ['23502'], ['23505'], ['23P01'], ['23001']])(
    'an integrity refusal (%s, class 23) is blocked',
    async (sqlstate) => {
      const { admin } = adminAnswering({
        data: { deletable: false, reason: 'blocked', sqlstate, constraint: 'some_chk', table: 'public.t' },
        error: null,
      });
      await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
        ok: false,
        kind: 'blocked',
        sqlstate,
        constraint: 'some_chk',
        table: 'public.t',
      });
    },
  );

  it.each([
    ['25006', 'a read-only transaction'],
    ['42501', 'a privilege the check lost'],
    ['42703', 'a column a half-applied revert dropped'],
    ['XX000', 'an internal error'],
    ['53100', 'a full disk'],
    ['P0001', 'a raise from a trigger in the cascade'],
  ])(
    'a non-integrity error (%s, %s) is check_failed, reported as an error, never "linked records"',
    async (sqlstate) => {
      const { admin } = adminAnswering({
        data: { deletable: false, reason: 'blocked', sqlstate, constraint: null, table: null },
        error: null,
      });
      await expect(checkAccountDeletable(admin, 'u-1', 'mobile')).resolves.toEqual({
        ok: false,
        kind: 'check_failed',
        sqlstate,
      });
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      const ctx = (reportErrorMock.mock.calls[0] as unknown[])[1] as {
        tag: string;
        level?: string;
        extra: Record<string, unknown>;
      };
      expect(ctx.tag).toBe('account.delete.check_failed');
      expect(ctx.level ?? 'error').toBe('error');
      expect(ctx.extra).toEqual({ source: 'mobile', sqlstate, constraint: null, table: null });
    },
  );

  it('a blocked answer with no sqlstate is check_failed (it cannot be told from a fault)', async () => {
    const { admin } = adminAnswering({
      data: { deletable: false, reason: 'blocked', constraint: null, table: null },
      error: null,
    });
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
  });

  it('not_found is gone (an account already deleted)', async () => {
    const { admin } = adminAnswering({ data: { deletable: false, reason: 'not_found' }, error: null });
    await expect(checkAccountDeletable(admin, 'u-1', 'platform')).resolves.toEqual({
      ok: false,
      kind: 'gone',
    });
  });

  it.each([
    ['an RPC error', { data: null, error: { code: '57014' } }],
    ['no_user', { data: { deletable: false, reason: 'no_user' }, error: null }],
    ['an unknown shape', { data: { something: 'else' }, error: null }],
    ['a null answer', { data: null, error: null }],
  ])('%s fails closed (check_failed) and is reported', async (_label, res) => {
    const { admin } = adminAnswering(res);
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.check_failed' }),
    );
  });

  it('a thrown client error fails closed, never throws', async () => {
    const { admin } = adminAnswering(new Error('fetch failed'));
    await expect(checkAccountDeletable(admin, 'u-1', 'web')).resolves.toEqual({
      ok: false,
      kind: 'check_failed',
    });
  });

  it('a truthy but non-true deletable is not deletable', async () => {
    const { admin } = adminAnswering({ data: { deletable: 'true' }, error: null });
    const res = await checkAccountDeletable(admin, 'u-1', 'web');
    expect(res.ok).toBe(false);
  });
});

/**
 * Review R7 (2026-10-03): deleteUser can answer an error although the account
 * is gone. Two cases: GoTrue committed and the reply was lost (a fetch
 * timeout, AuthRetryableFetchError status 0), or another request (the same
 * person's phone and browser at once) deleted it first, so this DELETE found
 * no user (404 user_not_found; shape read from the local GoTrue,
 * a2-evidence/review-gotrue-shapes.log). The caller must not tell the person
 * "could not be deleted" then.
 */
describe('settleFailedDelete', () => {
  function adminWith(getUserById: (id: string) => Promise<unknown>) {
    const fn = vi.fn(getUserById);
    return { admin: { auth: { admin: { getUserById: fn } } } as never, getUserById: fn };
  }
  const NOT_FOUND = { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' };
  const LOST_REPLY = { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' };

  it('404 user_not_found to the DELETE itself: deleted elsewhere, no second question', async () => {
    const { admin, getUserById } = adminWith(async () => ({ data: { user: null }, error: NOT_FOUND }));
    await expect(settleFailedDelete(admin, 'u-1', NOT_FOUND)).resolves.toBe('deleted_elsewhere');
    expect(getUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['a lost reply (status 0)', LOST_REPLY],
    ['a 500 from GoTrue', { name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'x' }],
  ])('%s, then GoTrue says the user does not exist: this request deleted it', async (_l, delErr) => {
    const { admin, getUserById } = adminWith(async () => ({ data: { user: null }, error: NOT_FOUND }));
    await expect(settleFailedDelete(admin, 'u-1', delErr)).resolves.toBe('deleted');
    expect(getUserById).toHaveBeenCalledWith('u-1');
  });

  it('the account is still there: not deleted', async () => {
    const { admin } = adminWith(async () => ({ data: { user: { id: 'u-1' } }, error: null }));
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('GoTrue cannot answer the second question either: not deleted (fail closed)', async () => {
    const { admin } = adminWith(async () => ({ data: { user: null }, error: LOST_REPLY }));
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('a thrown second question: not deleted, never throws', async () => {
    const { admin } = adminWith(async () => {
      throw new Error('admin client unusable');
    });
    await expect(settleFailedDelete(admin, 'u-1', LOST_REPLY)).resolves.toBe('not_deleted');
  });

  it('a 404 without the user_not_found code is not taken as proof', async () => {
    const { admin } = adminWith(async () => ({ data: { user: { id: 'u-1' } }, error: null }));
    await expect(
      settleFailedDelete(admin, 'u-1', { name: 'AuthApiError', status: 404, message: 'Not Found' }),
    ).resolves.toBe('not_deleted');
  });
});

describe('auditAccountDeleted', () => {
  it('writes user.deactivated with user_id null, the entity id, the reason, ip and user agent', async () => {
    await auditAccountDeleted({ userId: 'u-1', organizationId: 'org-1', reason: 'self_deletion' });
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith({
      organization_id: 'org-1',
      user_id: null,
      event: 'user.deactivated',
      ip: '203.0.113.7',
      user_agent: 'UA/1',
      metadata: {
        entity_type: 'user',
        entity_id: 'u-1',
        warehouse_id: null,
        before: null,
        after: null,
        reason: 'self_deletion',
      },
      // 0393: the row's actor is the person who deleted their account.
      deleted_users: { user_id: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    });
  });

  it('O-A3-5: records the counts of what the person created that keeps working, when they were read', async () => {
    await auditAccountDeleted({
      userId: 'u-1',
      organizationId: 'org-1',
      reason: 'self_deletion',
      createdStillActive: { apiKeys: 1, webhooks: 2, publicRequestLinks: 3, shareLinks: 4 },
    });
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: 'self_deletion',
          created_still_active: { api_keys: 1, webhooks: 2, public_request_links: 3, share_links: 4 },
        }),
      }),
    );
  });

  it('a person with no organization (SP-129) is written with organization_id null', async () => {
    await auditAccountDeleted({ userId: 'u-2', organizationId: null, reason: 'self_deletion_mobile' });
    expect(insertAuditRowReportedMock).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: null, user_id: null }),
    );
  });
});

describe("soleOwnedOrganizationsWithMembers (0393, the trigger's predicate, read with the user client)", () => {
  const ownedRow = (organization_id: string) => ({ organization_id });

  it('a member who owns nothing: no organization', async () => {
    const stub = makeSupabaseStub({ 'organization_members.select': { data: [], error: null } });
    await expect(soleOwnedOrganizationsWithMembers(stub.client, 'u-1')).resolves.toEqual({
      ok: true,
      organizations: [],
    });
  });

  it('reads only accepted, real (non-impersonation) rows: the owner rows and the co-members', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [ownedRow('org-a')], error: null }
          : { data: [{ organization_id: 'org-a', role: 'staff' }], error: null };
      },
      'organizations.select': { data: [{ id: 'org-a', name: 'Learn4Life' }], error: null },
    });
    await expect(soleOwnedOrganizationsWithMembers(stub.client, 'u-1')).resolves.toEqual({
      ok: true,
      organizations: [{ id: 'org-a', name: 'Learn4Life' }],
    });
    for (const chain of stub.chainsAll.get('organization_members.select') ?? []) {
      expect(chain).toEqual(expect.arrayContaining(['not', 'is']));
    }
    const args = stub.chainArgsAll.get('organization_members.select') ?? [];
    for (const a of args) {
      expect(a).toEqual(expect.arrayContaining([['accepted_at', 'is', null], ['impersonation_expires_at', null]]));
    }
  });

  it('a solo organization (no other accepted member) and one with a second owner do not block', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [ownedRow('org-solo'), ownedRow('org-two')], error: null }
          : { data: [{ organization_id: 'org-two', role: 'owner' }, { organization_id: 'org-two', role: 'staff' }], error: null };
      },
    });
    await expect(soleOwnedOrganizationsWithMembers(stub.client, 'u-1')).resolves.toEqual({
      ok: true,
      organizations: [],
    });
  });

  it.each([[1], [2]])('fails closed when read %i fails', async (failAt) => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === failAt
          ? { data: null, error: { message: 'fetch failed' } }
          : { data: [ownedRow('org-a')], error: null };
      },
    });
    await expect(soleOwnedOrganizationsWithMembers(stub.client, 'u-1')).resolves.toEqual({
      ok: false,
      message: 'fetch failed',
    });
  });

  it('still refuses, unnamed, when only the name read fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [ownedRow('org-a')], error: null }
          : { data: [{ organization_id: 'org-a', role: 'viewer' }], error: null };
      },
      'organizations.select': { data: null, error: { message: 'boom' } },
    });
    await expect(soleOwnedOrganizationsWithMembers(stub.client, 'u-1')).resolves.toEqual({
      ok: true,
      organizations: [{ id: 'org-a', name: null }],
    });
  });
});

describe('lastOwnerCopy', () => {
  it('names one organization, and points the phone to the web', () => {
    expect(lastOwnerCopy(['Learn4Life'], 'web')).toBe(
      // Re-pinned by the A3 review (was "Make another member the owner on the Team page"): the
      // Team page's control is "Transfer ownership…", and removing the other members also works.
      'You are the only owner of Learn4Life. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
    expect(lastOwnerCopy(['Learn4Life'], 'mobile')).toBe(
      'You are the only owner of Learn4Life. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
  });

  it('names several, "of each"', () => {
    expect(lastOwnerCopy(['A', 'B'], 'mobile')).toBe(
      'You are the only owner of A and B. For each, on the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
    expect(lastOwnerCopy(['A', 'B', 'C'], 'web')).toContain('the only owner of A, B and C.');
  });

  it('falls back to the generic sentence when a name is missing', () => {
    expect(lastOwnerCopy([null], 'web')).toBe(ACCOUNT_DELETE_LAST_OWNER_COPY);
    expect(lastOwnerCopy(['A', null], 'mobile')).toBe(ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE);
  });
});

describe('removeAvatarObjects (O-A3-9)', () => {
  function storageStub(pages: Array<{ name: string }[]>, opts: { listError?: boolean; removeError?: boolean } = {}) {
    const list = vi.fn(async () =>
      opts.listError ? { data: null, error: { message: 'list failed' } } : { data: pages.shift() ?? [], error: null },
    );
    const remove = vi.fn(async (_paths: string[]) =>
      opts.removeError ? { data: null, error: { message: 'remove failed' } } : { data: [], error: null },
    );
    const from = vi.fn(() => ({ list, remove }));
    return { admin: { storage: { from } } as never, from, list, remove };
  }

  it("removes the folder's files under user-avatars/<uid>/ and stops on a short page", async () => {
    const s = storageStub([[{ name: 'a.webp' }, { name: 'b.png' }]]);
    await removeAvatarObjects(s.admin, 'u-1');
    expect(s.from).toHaveBeenCalledWith('user-avatars');
    expect(s.list).toHaveBeenCalledWith('u-1', { limit: 1000 });
    expect(s.remove).toHaveBeenCalledTimes(1);
    expect(s.remove).toHaveBeenCalledWith(['u-1/a.webp', 'u-1/b.png']);
  });

  it('pages in chunks of 1,000 until the folder is empty', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}.png` }));
    const s = storageStub([full, [{ name: 'last.png' }]]);
    await removeAvatarObjects(s.admin, 'u-1');
    expect(s.remove).toHaveBeenCalledTimes(2);
    expect((s.remove.mock.calls[0]![0] as string[]).length).toBe(1000);
  });

  it('does nothing for an empty folder', async () => {
    const s = storageStub([[]]);
    await removeAvatarObjects(s.admin, 'u-1');
    expect(s.remove).not.toHaveBeenCalled();
  });

  it('reports a failure and never throws', async () => {
    const s = storageStub([], { listError: true });
    await expect(removeAvatarObjects(s.admin, 'u-1')).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'account.delete.avatar_list' }));
    const r = storageStub([[{ name: 'a.png' }]], { removeError: true });
    await expect(removeAvatarObjects(r.admin, 'u-1')).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'account.delete.avatar_remove' }));
  });
});

describe('the sentences', () => {
  it('say nothing changed, in plain words', () => {
    expect(ACCOUNT_DELETE_BLOCKED_COPY).toContain('Nothing was changed.');
    expect(ACCOUNT_DELETE_BLOCKED_COPY).toContain('Contact StockPilot support');
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY).toContain('Nothing was changed.');
    // Re-pinned by the A3 review (was 'on the Team page on the web'): the sentence now starts with it.
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE).toContain('On the Team page on the web');
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY).toBe(
      'You are the only owner of an organization that has other members. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
    expect(ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE).toBe(
      'You are the only owner of an organization that has other members. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    );
    expect(ACCOUNT_DELETE_PLATFORM_ADMIN_COPY).toBe(
      'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.',
    );
    expect(ACCOUNT_DELETE_RETRY_COPY).toBe(
      'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
    );
    expect(ACCOUNT_DELETE_SIGNED_OUT_COPY).toContain('You have been signed out');
    for (const s of [
      ACCOUNT_DELETE_BLOCKED_COPY,
      ACCOUNT_DELETE_RETRY_COPY,
      ACCOUNT_DELETE_SIGNED_OUT_COPY,
      ACCOUNT_DELETE_LAST_OWNER_COPY,
      ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
      ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
    ]) {
      expect(s.toLowerCase()).not.toMatch(/\bbook\b/);
    }
  });
});

describe('readDeletionReviewFacts (O-A3-5 counts, O-A3-2 solo owner with a subscription)', () => {
  /** The two organization_members reads, told apart by their filters. */
  function membersResult(owned: string[], others: string[]) {
    return (call: MockCall) =>
      callArgs(call, 'neq')
        ? { data: others.map((organization_id) => ({ organization_id })), error: null }
        : { data: owned.map((organization_id) => ({ organization_id })), error: null };
  }

  it('counts, in the audit organization, the API keys, webhooks, public request links and share links the person created that still work', async () => {
    const stub = makeSupabaseStub({
      'api_keys.select': { data: null, error: null, count: 1 },
      'integration_endpoints.select': { data: null, error: null, count: 2 },
      'public_request_links.select': { data: null, error: null, count: 3 },
      'maintenance_request_share_links.select': { data: null, error: null, count: 4 },
      'organization_members.select': membersResult([], []),
    });
    const facts = await readDeletionReviewFacts(stub.client, 'u-1', 'org-1', 'web');
    expect(facts.createdStillActive).toEqual({
      apiKeys: 1,
      webhooks: 2,
      publicRequestLinks: 3,
      shareLinks: 4,
    });
    const args = (t: string) => stub.chainArgsAll.get(`${t}.select`)?.[0] ?? [];
    for (const t of ['api_keys', 'integration_endpoints', 'public_request_links', 'maintenance_request_share_links']) {
      expect(args(t)).toEqual(
        expect.arrayContaining([
          ['id', { count: 'exact', head: true }],
          ['created_by', 'u-1'],
          ['organization_id', 'org-1'],
        ]),
      );
    }
    expect(args('api_keys')).toEqual(expect.arrayContaining([['revoked_at', null]]));
    expect(args('integration_endpoints')).toEqual(expect.arrayContaining([['enabled', true]]));
    expect(args('public_request_links')).toEqual(expect.arrayContaining([['active', true]]));
    expect(args('maintenance_request_share_links')).toEqual(
      expect.arrayContaining([['active', true], ['revoked_at', null]]),
    );
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a person with no organization: no counts (nothing to file them under), no count reads', async () => {
    const stub = makeSupabaseStub({ 'organization_members.select': membersResult([], []) });
    const facts = await readDeletionReviewFacts(stub.client, 'u-1', null, 'mobile');
    expect(facts.createdStillActive).toBeNull();
    expect(stub.fromCalls).not.toContain('api_keys');
  });

  it('a failed count read: counts null and reported (the deletion is never held up by it)', async () => {
    const stub = makeSupabaseStub({
      'api_keys.select': { data: null, error: { message: 'timeout' } },
      'organization_members.select': membersResult([], []),
    });
    const facts = await readDeletionReviewFacts(stub.client, 'u-1', 'org-1', 'web');
    expect(facts.createdStillActive).toBeNull();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.review_counts', level: 'warning' }),
    );
  });

  it('names the organizations the person is the only real member of that have a Stripe subscription', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': membersResult(['o-solo', 'o-team'], ['o-team']),
      'organizations.select': { data: [{ id: 'o-solo' }], error: null },
    });
    const facts = await readDeletionReviewFacts(stub.client, 'u-1', null, 'web');
    expect(facts.soloPaidOrganizationIds).toEqual(['o-solo']);
    const owned = stub.chainArgsAll.get('organization_members.select')?.[0] ?? [];
    expect(owned).toEqual(
      expect.arrayContaining([
        ['user_id', 'u-1'],
        ['role', 'owner'],
        ['accepted_at', 'is', null],
        ['impersonation_expires_at', null],
      ]),
    );
    const others = stub.chainArgsAll.get('organization_members.select')?.[1] ?? [];
    expect(others).toEqual(
      expect.arrayContaining([
        ['organization_id', ['o-solo', 'o-team']],
        ['user_id', 'u-1'],
        ['accepted_at', 'is', null],
        ['impersonation_expires_at', null],
      ]),
    );
    const orgs = stub.chainArgsAll.get('organizations.select')?.[0] ?? [];
    expect(orgs).toEqual(
      expect.arrayContaining([
        ['id', ['o-solo']],
        ['stripe_subscription_id', 'is', null],
      ]),
    );
  });

  it('not an owner, or every owned organization has other members: none, and no organizations read', async () => {
    const notOwner = makeSupabaseStub({ 'organization_members.select': membersResult([], []) });
    expect((await readDeletionReviewFacts(notOwner.client, 'u-1', null, 'web')).soloPaidOrganizationIds).toEqual([]);
    expect(notOwner.fromCalls).not.toContain('organizations');

    const team = makeSupabaseStub({ 'organization_members.select': membersResult(['o-team'], ['o-team']) });
    expect((await readDeletionReviewFacts(team.client, 'u-1', null, 'web')).soloPaidOrganizationIds).toEqual([]);
    expect(team.fromCalls).not.toContain('organizations');
  });

  it('a failed subscription read is reported so a platform admin can look (never holds up the deletion)', async () => {
    const stub = makeSupabaseStub({
      'organization_members.select': { data: null, error: { message: 'timeout' } },
    });
    const facts = await readDeletionReviewFacts(stub.client, 'u-1', null, 'web');
    expect(facts.soloPaidOrganizationIds).toEqual([]);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.review_subscription', level: 'warning' }),
    );
  });
});

describe('reportDeletionReviewFacts (O-A3-2)', () => {
  it('tells the platform admin (info) which deleted solo owner organizations keep a subscription', () => {
    reportDeletionReviewFacts({ createdStillActive: null, soloPaidOrganizationIds: ['o-solo'] }, 'mobile');
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'account.delete.solo_owner_subscription',
        level: 'info',
        extra: { source: 'mobile', organizationIds: 'o-solo' },
      }),
    );
  });

  it('says nothing when no such organization exists', () => {
    reportDeletionReviewFacts({ createdStillActive: null, soloPaidOrganizationIds: [] }, 'web');
    expect(reportErrorMock).not.toHaveBeenCalled();
  });
});

describe('lateLastOwnerRefusal (desk check F-5)', () => {
  it('true when the re-check answers last_owner (a member joined after the check): reported at info', async () => {
    const { admin, rpc } = adminAnswering({
      data: { deletable: false, reason: 'blocked', sqlstate: 'P0001', constraint: 'organization_last_owner', table: 'public.organization_members' },
      error: null,
    });
    await expect(lateLastOwnerRefusal(admin, 'u-1', 'web')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('account_deletion_check', { p_user_id: 'u-1' });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.late_last_owner', level: 'info' }),
    );
  });

  it('false for any other answer (the delete failed for another reason: SP-008 stays)', async () => {
    for (const res of [
      { data: { deletable: true }, error: null },
      { data: { deletable: false, reason: 'blocked', sqlstate: '55P03' }, error: null },
      { data: null, error: { code: 'PGRST301' } },
    ]) {
      const { admin } = adminAnswering(res);
      await expect(lateLastOwnerRefusal(admin, 'u-1', 'mobile')).resolves.toBe(false);
    }
  });
});
