import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 */

const { deleteUser, getUserById, recordPlatformAudit, reportError } = vi.hoisted(() => ({
  deleteUser: vi.fn(async (_uid: string) => ({
    error: null as { message: string; status?: number; code?: string; name?: string } | null,
  })),
  getUserById: vi.fn(async (_uid: string) => ({
    data: { user: { id: 'present' } as { id: string } | null },
    error: null as { message: string; status?: number; code?: string } | null,
  })),
  recordPlatformAudit: vi.fn(async (_row: unknown) => {}),
  reportError: vi.fn(async () => {}),
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
}));
vi.mock('@/lib/auth/platform-passphrase', () => ({
  hashPassphrase: vi.fn(),
  verifyPassphrase: vi.fn(() => true),
}));
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));

const ORG_ID = '0a000000-0000-0000-0000-000000000099';

/** account_deletion_check's answer per orphan. */
const answers: Record<string, unknown> = {};

const adminStub = makeSupabaseStub({
  'platform_settings.select': {
    data: { org_deletion_passphrase_hash: 'h', org_deletion_passphrase_salt: 's' },
    error: null,
  },
  'organizations.select': { data: { id: ORG_ID, name: 'Throwaway', slug: 'throwaway' }, error: null },
  'organizations.delete': { data: null, error: null },
  'organization_members.select': (call: MockCall) => {
    // The pre-delete member list, then the membership counts (0 = orphan).
    if (callArgs(call, 'select')?.[0] === 'user_id') {
      return {
        data: [
          { user_id: 'u-free' },
          { user_id: 'u-blocked' },
          { user_id: 'u-gone' },
          { user_id: 'u-fails' },
          { user_id: 'u-retry' },
          { user_id: 'u-broken' },
          { user_id: 'u-lost-reply' },
        ],
        error: null,
      };
    }
    return { data: null, error: null, count: 0 };
  },
  'rpc:account_deletion_check': (call: MockCall) => {
    const uid = (call.args[0]?.[0] as { p_user_id: string }).p_user_id;
    return { data: answers[uid] ?? { deletable: true }, error: null };
  },
});
(adminStub.client.auth as { admin?: unknown }).admin = { deleteUser, getUserById };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { removeOrgAction } from './platform-admin';

beforeEach(() => {
  vi.clearAllMocks();
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
  getUserById.mockImplementation(async (uid: string) =>
    uid === 'u-lost-reply'
      ? { data: { user: null }, error: { status: 404, code: 'user_not_found', message: 'User not found' } }
      : { data: { user: { id: uid } }, error: null },
  );
});

describe('removeOrgAction orphan cleanup', () => {
  it('deletes only what the check allows; kept (linked records) and failed are counted apart', async () => {
    const res = await removeOrgAction({
      orgId: ORG_ID,
      passphrase: 'pp',
      confirmName: 'Throwaway',
      alsoDeleteOrphanedUsers: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // u-free deleted; u-lost-reply deleted (its deleteUser errored but GoTrue
    // no longer has the user); u-blocked kept (linked records); u-fails failed
    // (its deleteUser { error } is read, no longer counted as deleted);
    // u-retry and u-broken failed (the check could not answer, never "linked
    // records"); u-gone already gone: neither.
    expect(res.data).toEqual({ deletedUsers: 2, keptUsers: 1, failedUsers: 3 });
    expect(deleteUser.mock.calls.map((c) => c[0]).sort()).toEqual(['u-fails', 'u-free', 'u-lost-reply']);
    expect(getUserById.mock.calls.map((c) => c[0]).sort()).toEqual(['u-fails', 'u-lost-reply']);
    expect(adminStub.rpcCalls.filter((c) => c.name === 'account_deletion_check').map((c) => c.args)).toEqual([
      { p_user_id: 'u-free' },
      { p_user_id: 'u-blocked' },
      { p_user_id: 'u-gone' },
      { p_user_id: 'u-fails' },
      { p_user_id: 'u-retry' },
      { p_user_id: 'u-broken' },
      { p_user_id: 'u-lost-reply' },
    ]);
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
        detail: expect.objectContaining({ deletedOrphanUsers: 2, keptOrphanUsers: 1, failedOrphanUsers: 3 }),
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
