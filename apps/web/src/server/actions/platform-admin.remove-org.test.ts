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
 * elsewhere is kept and counted, a failed delete is kept and counted, an
 * account already gone is neither.
 */

const { deleteUser, recordPlatformAudit, reportError } = vi.hoisted(() => ({
  deleteUser: vi.fn(async (_uid: string) => ({ error: null as { message: string } | null })),
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
        data: [{ user_id: 'u-free' }, { user_id: 'u-blocked' }, { user_id: 'u-gone' }, { user_id: 'u-fails' }],
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
(adminStub.client.auth as { admin?: unknown }).admin = { deleteUser };

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
  deleteUser.mockImplementation(async (uid: string) =>
    uid === 'u-fails' ? { error: { message: 'Database error deleting user' } } : { error: null },
  );
});

describe('removeOrgAction orphan cleanup', () => {
  it('deletes only what the check allows and counts the rest as kept', async () => {
    const res = await removeOrgAction({
      orgId: ORG_ID,
      passphrase: 'pp',
      confirmName: 'Throwaway',
      alsoDeleteOrphanedUsers: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // u-free deleted; u-blocked kept (linked records); u-fails kept (its
    // deleteUser { error } is read, no longer counted as deleted); u-gone
    // already gone: neither.
    expect(res.data).toEqual({ deletedUsers: 1, keptUsers: 2 });
    expect(deleteUser.mock.calls.map((c) => c[0]).sort()).toEqual(['u-fails', 'u-free']);
    expect(adminStub.rpcCalls.filter((c) => c.name === 'account_deletion_check').map((c) => c.args)).toEqual([
      { p_user_id: 'u-free' },
      { p_user_id: 'u-blocked' },
      { p_user_id: 'u-gone' },
      { p_user_id: 'u-fails' },
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'platform-admin.orphan-user-delete', extra: { uid: 'u-fails' } }),
    );
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_deleted',
        detail: expect.objectContaining({ deletedOrphanUsers: 1, keptOrphanUsers: 2 }),
      }),
    );
  });

  it('without the orphan option deletes no account and keeps none', async () => {
    const res = await removeOrgAction({ orgId: ORG_ID, passphrase: 'pp', confirmName: 'Throwaway' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ deletedUsers: 0, keptUsers: 0 });
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
