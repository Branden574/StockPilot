import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { createAdminClient } from '@/lib/supabase/admin';
import { audit } from '@/server/services/audit';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

// audit() is mocked so the test can assert HOW it was called. The whole point
// of this file is the second argument: a Bearer route MUST hand audit() its
// own ServiceContext, because audit()'s withContext() fallback calls
// requireOrgContext() → redirect('/signin') on any /api request (no session
// header) and the resulting NEXT_REDIRECT is swallowed by audit()'s own
// best-effort catch — the row just never gets written.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

const deleteUser = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ auth: { admin: { deleteUser } } })),
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
  });

  it('returns 401 without an auth context and never audits or deletes', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
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

  it('passes its ServiceContext to audit() so the user.deactivated row is actually written', async () => {
    const stub = happyStub();
    const ctx = buildCtx(stub);
    vi.mocked(withApiContext).mockResolvedValueOnce(ctx as never);

    const res = await POST(buildRequest({ confirm: 'DELETE' }));

    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledTimes(1);
    // Regression guard: audit(payload) with NO ctx silently dropped every
    // mobile self-deletion audit row. The context MUST be the second argument.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user.deactivated',
        entityType: 'user',
        entityId: USER_ID,
        reason: 'self_deletion_mobile',
      }),
      ctx,
    );
    const ctxArg = vi.mocked(audit).mock.calls[0]?.[1];
    expect(ctxArg).toBeDefined();
    expect(ctxArg?.organizationId).toBe('org-1');
    expect(ctxArg?.userId).toBe(USER_ID);
    expect(createAdminClient).toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith(USER_ID);
  });

  it('audits BEFORE the auth user is hard-deleted (the profile row still exists)', async () => {
    const stub = happyStub();
    const order: string[] = [];
    vi.mocked(audit).mockImplementationOnce(async () => {
      order.push('audit');
    });
    deleteUser.mockImplementationOnce(async () => {
      order.push('deleteUser');
      return { error: null };
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx(stub) as never);

    await POST(buildRequest({ confirm: 'DELETE' }));

    expect(order).toEqual(['audit', 'deleteUser']);
  });
});
