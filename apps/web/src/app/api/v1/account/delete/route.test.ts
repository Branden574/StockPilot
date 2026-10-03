import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit, insertAuditRowReported } from '@/server/services/audit';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

// The audit helpers are mocked so the test can assert HOW the row is written.
// Once, a Bearer route called audit() without its ServiceContext, and
// audit()'s withContext() fallback redirected on /api and dropped every mobile
// row. Since 0388 the row is written AFTER the delete through
// insertAuditRowReported (admin client, user_id null), never audit().
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  insertAuditRowReported: vi.fn(async () => true),
}));

const deleteUser = vi.fn(async (_id: string) => ({ error: null as { message: string } | null }));
/** account_deletion_check (0388), the dry run the route asks first. */
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
  data: { deletable: true } as unknown,
  error: null as { code?: string } | null,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ auth: { admin: { deleteUser } }, rpc })),
}));

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const checkRateLimit = vi.fn(async (_k: string, _l: number, _w: number) => ({
  allowed: true,
  count: 1,
  resetAt: 0,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (k: string, l: number, w: number) => checkRateLimit(k, l, w),
}));

vi.mock('@/server/services/platform/sessions', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({ ok: true, sessionIds: [] })),
}));

const USER_ID = '22222222-2222-2222-2222-222222222222';

function buildCtx(stub: SupabaseStub, role: Role = 'staff') {
  return {
    organizationId: 'org-1',
    userId: USER_ID,
    role,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    mfaEnrolled: false,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown) {
  return new Request('https://test.local/api/v1/account/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

/** No owned orgs, profile tombstone succeeds — the happy path. */
function happyStub() {
  return makeSupabaseStub({
    'organization_members.select': { data: [], error: null },
    'user_profiles.update': { data: null, error: null },
  });
}

describe('POST /api/v1/account/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteUser.mockResolvedValue({ error: null });
    rpc.mockResolvedValue({ data: { deletable: true }, error: null });
    checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: 0 });
  });

  it('returns 401 without an auth context and never audits or deletes', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('rejects a body that does not confirm, before touching the account', async () => {
    const stub = happyStub();
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'nope' }));

    expect(res.status).toBe(400);
    expect(audit).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('writes the user.deactivated row for the request organization (reason self_deletion_mobile), user_id null', async () => {
    const stub = happyStub();
    const ctx = buildCtx(stub);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    // Never audit(): its withContext() fallback redirects on /api.
    expect(audit).not.toHaveBeenCalled();
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        user_id: null,
        event: 'user.deactivated',
        metadata: expect.objectContaining({
          entity_type: 'user',
          entity_id: USER_ID,
          reason: 'self_deletion_mobile',
        }),
      }),
    );
    expect(createAdminClient).toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith(USER_ID);
    // No profile tombstone (0388).
    expect(stub.chains.get('user_profiles.update')).toBeUndefined();
  });

  // Replaced by 0388 (was "audits BEFORE the auth user is hard-deleted"): a
  // row written before a delete that then failed was a false audit row. The
  // order is now check, delete, audit.
  it('writes the audit row only after the delete succeeds (check, delete, audit)', async () => {
    const stub = happyStub();
    const order: string[] = [];
    rpc.mockImplementationOnce(async () => {
      order.push('check');
      return { data: { deletable: true }, error: null };
    });
    deleteUser.mockImplementationOnce(async () => {
      order.push('deleteUser');
      return { error: null };
    });
    vi.mocked(insertAuditRowReported).mockImplementationOnce(async () => {
      order.push('audit');
      return true;
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    await POST(buildRequest({ confirm: 'DELETE' }));

    expect(order).toEqual(['check', 'deleteUser', 'audit']);
    expect(rpc).toHaveBeenCalledWith('account_deletion_check', { p_user_id: USER_ID });
  });

  it('answers 500 with a message when the delete fails (it used to answer 200), revokes the sessions, writes no audit row', async () => {
    const stub = happyStub();
    deleteUser.mockResolvedValueOnce({ error: { message: 'Database error deleting user' } });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe(
      'Your account could not be deleted right now. You have been signed out; nothing else changed. Try again in a minute.',
    );
    expect(body.message).not.toContain('Database error');
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(USER_ID);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.auth_delete_failed' }),
    );
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('a blocked account gets 403 account_linked_records with the plain sentence, and nothing is deleted or written', async () => {
    const stub = happyStub();
    rpc.mockResolvedValueOnce({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: '23503',
        constraint: 'receipts_received_by_fkey',
        table: 'public.receipts',
      },
      error: null,
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('account_linked_records');
    expect(body.message).toContain('Nothing was changed.');
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(stub.chains.get('user_profiles.update')).toBeUndefined();
  });

  it.each([
    ['a check RPC error', { data: null, error: { code: '57014' } }],
    ['a row lock (55P03)', { data: { deletable: false, reason: 'blocked', sqlstate: '55P03' }, error: null }],
    ['a deadlock (40P01)', { data: { deletable: false, reason: 'blocked', sqlstate: '40P01' }, error: null }],
  ])('%s answers 503 try-again and changes nothing', async (_label, answer) => {
    const stub = happyStub();
    rpc.mockResolvedValueOnce(answer as never);
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toBe(
      'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
    );
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it('is rate limited before the check: 429 with retry-after', async () => {
    const stub = happyStub();
    checkRateLimit.mockResolvedValueOnce({ allowed: false, count: 5, resetAt: Date.now() + 60_000 });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(checkRateLimit).toHaveBeenCalledWith(`account-delete:${USER_ID}`, 5, 600_000);
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  // The sole-owner check fails CLOSED: a failed read of the caller's owned
  // orgs, or of their other members, used to read as "owns nothing" / "no
  // other members" and the account was deleted out from under an org that
  // still had people in it.
  it.each([
    ['owned-orgs', 1],
    ['other-members', 2],
  ])('a failed %s read refuses the delete and touches nothing', async (_label, failAt) => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        if (n === failAt) return { data: null, error: { message: 'fetch failed' } };
        return { data: [{ organization_id: 'org-1' }], error: null };
      },
      'user_profiles.update': { data: null, error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(500);
    expect(stub.chains.get('user_profiles.update')).toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
