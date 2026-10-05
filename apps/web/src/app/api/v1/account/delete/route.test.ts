import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit, insertAuditRowReported } from '@/server/services/audit';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';
import { ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE } from '@/server/lib/account-deletion';
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

const deleteUser = vi.fn(async (_id: string) => ({
  error: null as { message: string; status?: number; code?: string; name?: string } | null,
}));
/**
 * GoTrue's user read: first the platform-admin check's verified email (0394,
 * O-A3-7), then (review R7) again only after deleteUser answered an error.
 */
const getUserById = vi.fn(async (_id: string) => ({
  data: { user: { id: 'present', email: 'staff@x.org' } as { id: string; email?: string } | null },
  error: null as { message: string; status?: number; code?: string } | null,
}));
/** O-A3-9 (0394): user-avatars/<uid>/ is emptied after the delete. */
const avatarList = vi.fn(async (_prefix: string, _opts?: { limit?: number }) => ({
  data: [] as Array<{ name: string }> | null,
  error: null as { message: string } | null,
}));
const avatarRemove = vi.fn(async (_paths: string[]) => ({ data: [] as unknown, error: null }));
const storageFrom = vi.fn((_bucket: string) => ({ list: avatarList, remove: avatarRemove }));
/** account_deletion_check (0388), the dry run the route asks first. */
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
  data: { deletable: true } as unknown,
  error: null as { code?: string } | null,
}));
/** The admin client's table reads (O-A3-2, O-A3-5: read before the delete). */
const adminTables: { stub: SupabaseStub | null } = { stub: null };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { deleteUser, getUserById } },
    rpc,
    from: (table: string) => {
      if (!adminTables.stub) throw new Error('admin table read not expected in this test');
      return adminTables.stub.client.from(table);
    },
    storage: { from: storageFrom },
  })),
}));

/** O-A3-7: the allowlist check, driven per test. */
const isPlatformAdmin = vi.fn((_email: string | null | undefined) => false);
vi.mock('@/lib/auth/platform-admin', () => ({
  isPlatformAdmin: (e: string | null | undefined) => isPlatformAdmin(e),
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
    getUserById.mockResolvedValue({ data: { user: { id: USER_ID, email: 'staff@x.org' } }, error: null });
    rpc.mockResolvedValue({ data: { deletable: true }, error: null });
    checkRateLimit.mockResolvedValue({ allowed: true, count: 1, resetAt: 0 });
    isPlatformAdmin.mockImplementation(() => false);
    avatarList.mockResolvedValue({ data: [], error: null });
    avatarRemove.mockResolvedValue({ data: [], error: null });
    // No API keys, webhooks, links or subscriptions unless a test says so.
    adminTables.stub = makeSupabaseStub();
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
    avatarList.mockImplementationOnce(async () => {
      order.push('avatars');
      return { data: [], error: null };
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    await POST(buildRequest({ confirm: 'DELETE' }));

    // Re-pinned by 0394 (was ['check', 'deleteUser', 'audit']): the avatar
    // files are removed once the account is gone, before the audit row.
    expect(order).toEqual(['check', 'deleteUser', 'avatars', 'audit']);
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

  // Review R7 (2026-10-03): deleteUser can answer an error although the
  // account is gone. The phone used to get 500 "could not be deleted" and no
  // audit row was written; now the route asks GoTrue again.
  it('a lost reply, then GoTrue has no such user: 200, the audit row written, no revoke', async () => {
    const stub = happyStub();
    deleteUser.mockResolvedValueOnce({
      error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
    });
    // 0394: the platform-admin check reads the user first (still there).
    getUserById.mockResolvedValueOnce({ data: { user: { id: USER_ID, email: 'staff@x.org' } }, error: null });
    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, code: 'user_not_found', message: 'User not found' },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getUserById).toHaveBeenCalledTimes(2);
    expect(getUserById).toHaveBeenNthCalledWith(2, USER_ID);
    expect(insertAuditRowReported).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        user_id: null,
        metadata: expect.objectContaining({ entity_id: USER_ID, reason: 'self_deletion_mobile' }),
      }),
    );
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.auth_delete_error_but_gone', level: 'warning' }),
    );
  });

  it('404 user_not_found to the delete (deleted by another request): 200, no second audit row', async () => {
    const stub = happyStub();
    deleteUser.mockResolvedValueOnce({
      error: { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User not found' },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    // Re-pinned by 0394 (was not called at all): read once, by the
    // platform-admin check before the delete; never again to settle it.
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    // The request that deleted it removes the avatar files.
    expect(avatarList).not.toHaveBeenCalled();
  });

  it('the check finds no such account: 200, nothing deleted or written here', async () => {
    const stub = happyStub();
    rpc.mockResolvedValueOnce({ data: { deletable: false, reason: 'not_found' }, error: null });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  // Review R1: an error the dry run caught that is not an integrity refusal
  // is "try again" (503), never "linked to records" (403).
  it('a non-integrity error in the dry run (42501) answers 503 try-again, not 403', async () => {
    const stub = happyStub();
    rpc.mockResolvedValueOnce({
      data: { deletable: false, reason: 'blocked', sqlstate: '42501', constraint: null, table: null },
      error: null,
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('check_failed');
    expect(deleteUser).not.toHaveBeenCalled();
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
    // Re-pinned by 0394 (was "linked to records your organization keeps"):
    // no business key refuses after 0394, so this is the support sentence.
    expect(body.message).toBe(
      'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.',
    );
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(stub.chains.get('user_profiles.update')).toBeUndefined();
    expect(avatarList).not.toHaveBeenCalled();
  });

  // 0394: the only owner of an organization that has other members is
  // refused, naming it; ownership moves on the web Team page (O-A3-8).
  it('the only owner of an org with other members gets 403 last_owner naming it, before the rate limit and the check', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': () => {
        n += 1;
        return n === 1
          ? { data: [{ organization_id: 'org-1' }], error: null }
          : { data: [{ organization_id: 'org-1', role: 'viewer' }], error: null };
      },
      'organizations.select': { data: [{ id: 'org-1', name: 'Learn4Life' }], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub, 'owner') as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'last_owner',
      message:
        'You are the only owner of Learn4Life. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it('the check answering last owner (a member joined in between) gets 403 last_owner with the generic phone sentence', async () => {
    const stub = happyStub();
    rpc.mockResolvedValueOnce({
      data: {
        deletable: false,
        reason: 'blocked',
        sqlstate: 'P0001',
        constraint: 'organization_last_owner',
        table: 'public.organization_members',
      },
      error: null,
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub, 'owner') as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'last_owner',
      message:
        'You are the only owner of an organization that has other members. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.',
    });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  // O-A3-7 (0394): the allowlist is checked against GoTrue's verified email.
  it('a platform admin account gets 403 platform_admin (the verified GoTrue email) and nothing changes', async () => {
    const stub = happyStub();
    getUserById.mockResolvedValueOnce({ data: { user: { id: USER_ID, email: 'ops@stockpilotusa.com' } }, error: null });
    isPlatformAdmin.mockImplementation((e) => e === 'ops@stockpilotusa.com');
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'platform_admin',
      message:
        'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.',
    });
    expect(getUserById).toHaveBeenCalledWith(USER_ID);
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it('an email read that fails answers 503 try-again and changes nothing (fails closed)', async () => {
    const stub = happyStub();
    getUserById.mockResolvedValueOnce({ data: { user: null }, error: { status: 500, message: 'boom' } });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('check_failed');
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'account.delete.platform_admin_check' }),
    );
  });

  it('GoTrue has no such user at the email read (deleted from another device): 200, nothing deleted or written here', async () => {
    const stub = happyStub();
    getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, code: 'user_not_found', message: 'User not found' },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
  });

  it('removes the avatar files under user-avatars/<uid>/ after the delete (O-A3-9)', async () => {
    const stub = happyStub();
    avatarList.mockResolvedValueOnce({ data: [{ name: 'me.webp' }], error: null });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(storageFrom).toHaveBeenCalledWith('user-avatars');
    expect(avatarList).toHaveBeenCalledWith(USER_ID, { limit: 1000 });
    expect(avatarRemove).toHaveBeenCalledWith([`${USER_ID}/me.webp`]);
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

  it("O-A3-5: the user.deactivated row records the organization's API keys, webhooks and links the person created that keep working", async () => {
    adminTables.stub = makeSupabaseStub({
      'api_keys.select': { data: null, error: null, count: 2 },
      'integration_endpoints.select': { data: null, error: null, count: 1 },
      'public_request_links.select': { data: null, error: null, count: 0 },
      'maintenance_request_share_links.select': { data: null, error: null, count: 0 },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(happyStub()) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(insertAuditRowReported).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        metadata: expect.objectContaining({
          created_still_active: { api_keys: 2, webhooks: 1, public_request_links: 0, share_links: 0 },
        }),
      }),
    );
    // Counted in the organization the row is filed under, before the delete.
    const args = adminTables.stub.chainArgsAll.get('api_keys.select')?.[0] ?? [];
    expect(args).toEqual(expect.arrayContaining([['created_by', USER_ID], ['organization_id', 'org-1']]));
    expect(adminTables.stub.fromCalls.indexOf('api_keys')).toBeGreaterThanOrEqual(0);
  });

  it('O-A3-2: the only member of an organization with a Stripe subscription: the platform admin is told (info) after the delete', async () => {
    adminTables.stub = makeSupabaseStub({
      'organization_members.select': (call) =>
        call.methods.includes('neq')
          ? { data: [], error: null }
          : { data: [{ organization_id: 'org-1' }], error: null },
      'organizations.select': { data: [{ id: 'org-1' }], error: null },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(happyStub(), 'owner') as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tag: 'account.delete.solo_owner_subscription',
        level: 'info',
        extra: { source: 'mobile', organizationIds: 'org-1' },
      }),
    );
  });

  it('desk check F-5: a member joins between the check and the delete: the last-owner answer, sessions kept, nothing written', async () => {
    deleteUser.mockResolvedValueOnce({
      error: { name: 'AuthApiError', status: 500, message: 'Database error deleting user' },
    });
    rpc
      .mockResolvedValueOnce({ data: { deletable: true }, error: null })
      .mockResolvedValueOnce({
        data: {
          deletable: false,
          reason: 'blocked',
          sqlstate: 'P0001',
          constraint: 'organization_last_owner',
          table: 'public.organization_members',
        },
        error: null,
      });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(happyStub(), 'owner') as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('last_owner');
    expect(body.message).toBe(ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE);
    expect(revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(insertAuditRowReported).not.toHaveBeenCalled();
    expect(avatarList).not.toHaveBeenCalled();
  });

  it('desk check F-5: any other answer to the re-check keeps SP-008 (sessions revoked, 500)', async () => {
    deleteUser.mockResolvedValueOnce({
      error: { name: 'AuthApiError', status: 500, message: 'Database error deleting user' },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(happyStub()) as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(500);
    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(USER_ID);
  });
});
