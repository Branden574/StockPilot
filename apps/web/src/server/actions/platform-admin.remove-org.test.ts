import { beforeEach, describe, expect, it, vi } from 'vitest';

import { orphanAccountNotices } from '@/components/platform/remove-org-notices';
import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * removeOrgAction's orphan-account cleanup (migration 0388).
 *
 * After the organization is deleted, each member whose ONLY organization it
 * was may be deleted too. The action used to call deleteUser, ignore its
 * `{ error }` and count the account as deleted anyway, so the operator's dialog
 * and the platform audit could claim accounts were gone while they were not.
 * Now it asks account_deletion_check first: an account linked to records kept
 * elsewhere is KEPT and counted; a check that could not answer, or a delete
 * that failed, is counted as FAILED (review R8: it used to be counted as kept
 * "because linked to records", so a transient fault read as a permanent
 * refusal); a delete that errored although GoTrue no longer has the user is
 * DELETED (review R7); an account already gone is neither.
 *
 * 0393: every member is deletable now, so KEPT is chiefly a platform admin's
 * account while its email is on the allowlist (O-A3-7), read from GoTrue
 * first; an email read that fails is FAILED; and each deleted account's
 * avatar files are removed (O-A3-9).
 *
 * A read that answers an error (or a count with no number) is never read as
 * "no passphrase", "no organization" or "no other organization": a failed read
 * before the organization is deleted removes nothing, and a failed count taken
 * again right before an account's delete keeps it, counted as failed.
 */

const { deleteUser, getUserById, recordPlatformAudit, reportError, avatarList, avatarRemove } = vi.hoisted(() => ({
  deleteUser: vi.fn(async (_uid: string) => ({
    error: null as { message: string; status?: number; code?: string; name?: string } | null,
  })),
  getUserById: vi.fn(async (_uid: string) => ({
    data: { user: { id: 'present' } as { id: string } | null },
    error: null as { message: string; status?: number; code?: string } | null,
  })),
  recordPlatformAudit: vi.fn(async (_row: unknown) => {}),
  reportError: vi.fn(async () => {}),
  avatarList: vi.fn(async (_prefix: string, _opts?: { limit?: number }) => ({
    data: [] as Array<{ name: string }> | null,
    error: null as { message: string } | null,
  })),
  avatarRemove: vi.fn(async (_paths: string[]) => ({ data: [] as unknown, error: null })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('@/server/services/platform/audit', () => ({ recordPlatformAudit }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: vi.fn(async () => ({
    ok: true,
    session: { userId: 'pa-1', email: 'ops@stockpilotusa.com' },
  })),
  // The allowlist (O-A3-7): one orphan below is an operator account.
  isPlatformAdmin: (email: string | null | undefined) => email === 'second-ops@stockpilotusa.com',
}));
vi.mock('@/lib/auth/platform-passphrase', () => ({
  hashPassphrase: vi.fn(),
  verifyPassphrase: vi.fn(() => true),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));

const ORG_ID = '0a000000-0000-0000-0000-000000000099';

/** account_deletion_check's answer per orphan. */
const answers: Record<string, unknown> = {};

/**
 * Per test: a failed read of the stored passphrase or of the organization, the
 * member list to answer, a failed read of it, and a failed membership count for
 * one account (`otherOrgsOnly`: the count taken before the organization is
 * deleted, of the account's OTHER organizations; else the count taken again
 * right before the account would be deleted). `noCount`: the count answers no
 * number and no error.
 */
const memberReads: {
  settingsFail: boolean;
  orgFail: boolean;
  memberIds: string[] | null;
  membersFail: boolean;
  countFails: { uid: string; otherOrgsOnly: boolean; noCount?: boolean } | null;
} = { settingsFail: false, orgFail: false, memberIds: null, membersFail: false, countFails: null };

const READ_FAILED = { message: 'canceling statement due to statement timeout', code: '57014' };

/** Made-up values: the stored row, and what the operator types. */
const STORED_DIGEST = 'h';
const STORED_SALT_VALUE = 's';
const TYPED_VALUE = 'pp';

const adminStub = makeSupabaseStub({
  'platform_settings.select': () =>
    memberReads.settingsFail
      ? { data: null, error: READ_FAILED }
      : {
          data: { org_deletion_passphrase_hash: STORED_DIGEST, org_deletion_passphrase_salt: STORED_SALT_VALUE },
          error: null,
        },
  'organizations.select': () =>
    memberReads.orgFail
      ? { data: null, error: READ_FAILED }
      : { data: { id: ORG_ID, name: 'Throwaway', slug: 'throwaway' }, error: null },
  'organizations.delete': { data: null, error: null },
  'organization_members.select': (call: MockCall) => {
    // The pre-delete member list, then the membership counts (0 = orphan).
    if (callArgs(call, 'select')?.[0] === 'user_id') {
      if (memberReads.membersFail) return { data: null, error: READ_FAILED };
      const ids = memberReads.memberIds;
      if (ids) return { data: ids.map((user_id) => ({ user_id })), error: null };
      return {
        data: [
          { user_id: 'u-free' },
          { user_id: 'u-blocked' },
          { user_id: 'u-gone' },
          { user_id: 'u-fails' },
          { user_id: 'u-retry' },
          { user_id: 'u-broken' },
          { user_id: 'u-lost-reply' },
          { user_id: 'u-admin' },
          { user_id: 'u-email-fails' },
          { user_id: 'u-gone-early' },
        ],
        error: null,
      };
    }
    const uid = callArgs(call, 'eq')?.[1];
    const otherOrgsOnly = call.methods.includes('neq');
    const fails = memberReads.countFails;
    if (fails && fails.uid === uid && fails.otherOrgsOnly === otherOrgsOnly) {
      return fails.noCount ? { data: null, error: null } : { data: null, error: READ_FAILED, count: null };
    }
    return { data: null, error: null, count: 0 };
  },
  'rpc:account_deletion_check': (call: MockCall) => {
    const uid = (call.args[0]?.[0] as { p_user_id: string }).p_user_id;
    return { data: answers[uid] ?? { deletable: true }, error: null };
  },
});
(adminStub.client.auth as { admin?: unknown }).admin = { deleteUser, getUserById };
(adminStub.client as { storage: unknown }).storage = {
  from: vi.fn((_bucket: string) => ({ list: avatarList, remove: avatarRemove })),
};

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { removeOrgAction } from './platform-admin';

beforeEach(() => {
  vi.clearAllMocks();
  memberReads.settingsFail = false;
  memberReads.orgFail = false;
  memberReads.memberIds = null;
  memberReads.membersFail = false;
  memberReads.countFails = null;
  for (const k of Object.keys(answers)) delete answers[k];
  answers['u-blocked'] = {
    deletable: false,
    reason: 'blocked',
    sqlstate: '23503',
    constraint: 'receipts_received_by_fkey',
    table: 'public.receipts',
  };
  answers['u-gone'] = { deletable: false, reason: 'not_found' };
  // A row lock (try again), and a fault that is not a refusal (review R1).
  answers['u-retry'] = { deletable: false, reason: 'blocked', sqlstate: '55P03', constraint: null, table: null };
  answers['u-broken'] = { deletable: false, reason: 'blocked', sqlstate: '42501', constraint: null, table: null };
  deleteUser.mockImplementation(async (uid: string) => {
    if (uid === 'u-fails') return { error: { message: 'Database error deleting user' } };
    if (uid === 'u-lost-reply') {
      return { error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' } };
    }
    return { error: null };
  });
  // Per account: the first read is the platform-admin check's email (0393);
  // a second read settles a delete that answered an error (review R7).
  const reads = new Map<string, number>();
  const NOT_FOUND = { status: 404, code: 'user_not_found', message: 'User not found' };
  getUserById.mockImplementation(async (uid: string) => {
    const n = (reads.get(uid) ?? 0) + 1;
    reads.set(uid, n);
    if (uid === 'u-email-fails') return { data: { user: null }, error: { status: 500, message: 'boom' } };
    if (uid === 'u-gone-early') return { data: { user: null }, error: NOT_FOUND };
    if (uid === 'u-lost-reply' && n > 1) return { data: { user: null }, error: NOT_FOUND };
    const email = uid === 'u-admin' ? 'second-ops@stockpilotusa.com' : `${uid}@x.org`;
    return { data: { user: { id: uid, email } }, error: null };
  });
  avatarList.mockImplementation(async () => ({ data: [], error: null }));
});

describe('removeOrgAction orphan cleanup', () => {
  // Re-pinned by 0393 (was { deletedUsers: 2, keptUsers: 1, failedUsers: 3 }
  // over seven orphans, kept meaning "linked records"): three orphans added
  // for the platform-admin email read.
  it('deletes only what the check allows; kept (platform admin, a refusal) and failed are counted apart', async () => {
    const res = await removeOrgAction({
      orgId: ORG_ID,
      passphrase: 'pp',
      confirmName: 'Throwaway',
      alsoDeleteOrphanedUsers: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // u-free deleted; u-lost-reply deleted (its deleteUser errored but GoTrue
    // no longer has the user); u-blocked kept (a refusal); u-admin kept (a
    // platform admin's email, O-A3-7); u-fails failed (its deleteUser { error }
    // is read, no longer counted as deleted); u-retry and u-broken failed (the
    // check could not answer, never a refusal); u-email-fails failed (its email
    // could not be read); u-gone and u-gone-early already gone: neither.
    expect(res.data).toEqual({ deletedUsers: 2, keptUsers: 2, failedUsers: 4 });
    expect(deleteUser.mock.calls.map((c) => c[0]).sort()).toEqual(['u-fails', 'u-free', 'u-lost-reply']);
    // Every orphan's email is read once; the two errored deletes are settled.
    const readsPerUser = new Map<string, number>();
    for (const [uid] of getUserById.mock.calls) readsPerUser.set(uid, (readsPerUser.get(uid) ?? 0) + 1);
    expect(Object.fromEntries(readsPerUser)).toEqual({
      'u-free': 1,
      'u-blocked': 1,
      'u-gone': 1,
      'u-fails': 2,
      'u-retry': 1,
      'u-broken': 1,
      'u-lost-reply': 2,
      'u-admin': 1,
      'u-email-fails': 1,
      'u-gone-early': 1,
    });
    expect(adminStub.rpcCalls.filter((c) => c.name === 'account_deletion_check').map((c) => c.args)).toEqual([
      { p_user_id: 'u-free' },
      { p_user_id: 'u-blocked' },
      { p_user_id: 'u-gone' },
      { p_user_id: 'u-fails' },
      { p_user_id: 'u-retry' },
      { p_user_id: 'u-broken' },
      { p_user_id: 'u-lost-reply' },
    ]);
    // The platform admin's account is kept and reported at info; the failed
    // email read is reported.
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'platform-admin.orphan-platform-admin-kept',
        level: 'info',
        extra: { uid: 'u-admin' },
      }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform-admin.orphan-user-email', extra: { uid: 'u-email-fails' } }),
    );
    // Avatar files are removed for the two deleted accounts only (O-A3-9).
    expect(avatarList.mock.calls.map((c) => c[0]).sort()).toEqual(['u-free', 'u-lost-reply']);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'platform-admin.orphan-user-delete',
        extra: { uid: 'u-fails', settled: 'not_deleted' },
      }),
    );
    // The lost reply is still reported, as a warning (the account is gone).
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'platform-admin.orphan-user-delete',
        level: 'warning',
        extra: { uid: 'u-lost-reply', settled: 'deleted' },
      }),
    );
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_deleted',
        detail: expect.objectContaining({ deletedOrphanUsers: 2, keptOrphanUsers: 2, failedOrphanUsers: 4 }),
      }),
    );
  });

  it('without the orphan option deletes no account and keeps none', async () => {
    const res = await removeOrgAction({ orgId: ORG_ID, passphrase: 'pp', confirmName: 'Throwaway' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ deletedUsers: 0, keptUsers: 0, failedUsers: 0 });
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe('removeOrgAction when a read fails', () => {
  const orgDeletes = () => adminStub.chainsAll.get('organizations.delete')?.length ?? 0;
  const REMOVE = { orgId: ORG_ID, passphrase: TYPED_VALUE, confirmName: 'Throwaway', alsoDeleteOrphanedUsers: true };

  /** Nothing removed: the organization, every account and the audit are untouched. */
  async function expectNothingRemoved(message: string, tag: string) {
    const before = orgDeletes();
    const res = await removeOrgAction(REMOVE);
    expect(res).toEqual({ ok: false, error: { code: 'internal_error', message } });
    expect(orgDeletes()).toBe(before);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag }));
  }

  it('removes nothing when the stored passphrase could not be read', async () => {
    memberReads.settingsFail = true;
    await expectNothingRemoved(
      'Could not read the deletion passphrase, so nothing was removed. Try again.',
      'platform-admin.remove-org-passphrase-read',
    );
  });

  it('removes nothing when the organization could not be read', async () => {
    memberReads.orgFail = true;
    await expectNothingRemoved(
      'Could not read the organization, so nothing was removed. Try again.',
      'platform-admin.remove-org-read',
    );
  });

  it('removes nothing when the member list could not be read', async () => {
    memberReads.membersFail = true;
    await expectNothingRemoved(
      "Could not read the organization's members, so nothing was removed. Try again.",
      'platform-admin.orphan-members-read',
    );
  });

  it("removes nothing when a member's other-organizations count could not be read", async () => {
    memberReads.memberIds = ['u-free', 'u-unread'];
    memberReads.countFails = { uid: 'u-unread', otherOrgsOnly: true };
    await expectNothingRemoved(
      'Could not read whether each member belongs to another organization, so nothing was removed. Try again.',
      'platform-admin.orphan-membership-read',
    );
  });

  it("removes nothing when a member's other-organizations count answers no number", async () => {
    memberReads.memberIds = ['u-free', 'u-unread'];
    memberReads.countFails = { uid: 'u-unread', otherOrgsOnly: true, noCount: true };
    await expectNothingRemoved(
      'Could not read whether each member belongs to another organization, so nothing was removed. Try again.',
      'platform-admin.orphan-membership-read',
    );
  });

  it('keeps a member whose membership count could not be read again right before the delete', async () => {
    memberReads.memberIds = ['u-free', 'u-unread'];
    memberReads.countFails = { uid: 'u-unread', otherOrgsOnly: false };
    const res = await removeOrgAction(REMOVE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(deleteUser.mock.calls.map((c) => c[0])).toEqual(['u-free']);
    expect(res.data).toEqual({ deletedUsers: 1, keptUsers: 0, failedUsers: 1 });
    // The dialog's sentence for it: left in place, the report has the details.
    expect(orphanAccountNotices(res.data).failed).toBe(
      '1 account could not be deleted right now and was left in place. The error report has the details.',
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform-admin.orphan-membership-read', extra: { uid: 'u-unread' } }),
    );
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_deleted',
        detail: expect.objectContaining({ deletedOrphanUsers: 1, keptOrphanUsers: 0, failedOrphanUsers: 1 }),
      }),
    );
  });

  it('keeps a member whose membership count answers no number right before the delete', async () => {
    memberReads.memberIds = ['u-free', 'u-unread'];
    memberReads.countFails = { uid: 'u-unread', otherOrgsOnly: false, noCount: true };
    const res = await removeOrgAction(REMOVE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(deleteUser.mock.calls.map((c) => c[0])).toEqual(['u-free']);
    expect(res.data).toEqual({ deletedUsers: 1, keptUsers: 0, failedUsers: 1 });
  });
});
