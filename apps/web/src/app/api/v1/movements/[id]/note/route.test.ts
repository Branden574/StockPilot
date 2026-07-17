import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Permission, Role } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import { PATCH } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
}));

// Mock audit so the route can be asserted without the admin client / next
// headers() a real audit() would reach for — and so we can prove it's called
// with the right old→new payload.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

const MOVEMENT_ID = '11111111-1111-1111-1111-111111111111';

function buildCtx(
  role: Role,
  stub: SupabaseStub,
  permissions?: Set<Permission>,
) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    // Omit `permissions` (undefined) → can()/assertPermission fall back to the
    // static role defaults, which is what we want for the role-only cases.
    ...(permissions ? { permissions } : {}),
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  };
}

function buildRequest(body: unknown, id = MOVEMENT_ID) {
  return new Request(`https://test.local/api/v1/movements/${id}/note`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PATCH>[0];
}

function buildParams(id = MOVEMENT_ID) {
  return { params: Promise.resolve({ id }) };
}

describe('PATCH /api/v1/movements/[id]/note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('returns 401 when there is no auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await PATCH(buildRequest({ note: 'hi' }), buildParams());
    expect(res.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns 403 for a viewer without the permission and never calls the RPC', async () => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('viewer', stub));

    const res = await PATCH(buildRequest({ note: 'hi' }), buildParams());

    expect(res.status).toBe(403);
    // Gate is asserted BEFORE the RPC — a denied caller must not reach the DB.
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('edits the note (manager), calls the RPC with the right args, and audits old→new', async () => {
    const stub = makeSupabaseStub({
      'rpc:edit_movement_note': {
        data: [{ item_id: 'item-1', old_note: 'previous note' }],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager', stub));

    // Surrounding whitespace proves the response + audit reflect the STORED
    // (trimmed) value, not the raw input — matching the RPC's nullif(btrim()).
    const res = await PATCH(buildRequest({ note: '  fixed note  ' }), buildParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, note: 'fixed note' });

    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'edit_movement_note',
      args: { p_movement_id: MOVEMENT_ID, p_note: '  fixed note  ' },
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      {
        event: 'stock_movement.note_edited',
        entityType: 'inventory_item',
        entityId: 'item-1',
        before: { notes: 'previous note' },
        after: { notes: 'fixed note' },
        reason: 'movement_note_edited',
        extra: { movement_id: MOVEMENT_ID },
      },
      // Second arg is the ServiceContext so audit() doesn't fall back to
      // withContext() (which throws NEXT_REDIRECT on the API path).
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('clears the note when passed null and audits after=null', async () => {
    const stub = makeSupabaseStub({
      'rpc:edit_movement_note': {
        data: [{ item_id: 'item-1', old_note: 'was here' }],
        error: null,
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager', stub));

    const res = await PATCH(buildRequest({ note: null }), buildParams());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, note: null });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ before: { notes: 'was here' }, after: { notes: null } }),
      expect.anything(),
    );
  });

  it('maps the RPC 42501 (additive-gate denial) to 403 without auditing', async () => {
    const stub = makeSupabaseStub({
      'rpc:edit_movement_note': {
        data: null,
        error: { code: '42501', message: 'insufficient privilege' },
      },
    });
    // Give a staff member the granted permission so assertPermission passes and
    // the RPC path is exercised — the RPC itself then denies (e.g. cross-org id).
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx('staff', stub, new Set<Permission>(['movements:edit_notes'])),
    );

    const res = await PATCH(buildRequest({ note: 'hi' }), buildParams());

    expect(res.status).toBe(403);
    expect(stub.rpcCalls).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps the RPC "movement not found" to 404', async () => {
    const stub = makeSupabaseStub({
      'rpc:edit_movement_note': {
        data: null,
        error: { code: 'P0001', message: 'movement not found' },
      },
    });
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager', stub));

    const res = await PATCH(buildRequest({ note: 'hi' }), buildParams());

    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns 400 for a note over the 2000-char cap and never calls the RPC', async () => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager', stub));

    const res = await PATCH(buildRequest({ note: 'x'.repeat(2001) }), buildParams());

    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid (non-uuid) movement id', async () => {
    const stub = makeSupabaseStub({});
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx('manager', stub));

    const res = await PATCH(buildRequest({ note: 'hi' }, 'not-a-uuid'), buildParams('not-a-uuid'));

    expect(res.status).toBe(400);
    expect(stub.rpcCalls).toHaveLength(0);
  });
});
