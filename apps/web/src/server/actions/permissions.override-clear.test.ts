/**
 * MED-14 (Wave C2): clearing a permission override must go through the SAME
 * anti-escalation rule as granting one.
 *
 * WHY THIS FILE EXISTS
 *   assertCanGrant used to inspect only `granted === true`, so the
 *   `granted === null` branch — which DELETEs the override row — was ungated.
 *   Deleting a `granted = false` row removes a RESTRICTION, and the subject
 *   reverts to their role default. That is an escalation, and it meant an admin
 *   could clear an owner-applied restriction off their own account for a
 *   permission they do not hold (billing:manage being the motivating case).
 *
 *   These tests pin all four quadrants of the rule, because the fix is a
 *   polarity change (`granted === true` -> `granted !== false`) and a polarity
 *   change is exactly the kind of edit that silently over- or under-shoots:
 *     granted=true  + lacks permission -> DENY   (pre-existing rule, unchanged)
 *     granted=null  + lacks permission -> DENY   (the fix)
 *     granted=null  + holds permission -> ALLOW  (must not become an outage)
 *     granted=false + lacks permission -> ALLOW  (a revoke can never escalate)
 *   The owner escape hatch gets its own case: an owner must always be able to
 *   clear a bad state, which works because can() short-circuits for 'owner'.
 *
 * The database enforces the same invariant independently — see the
 * *_overrides_delete policies in migration 0322 and their pgTAP coverage in
 * supabase/tests/0322_*.test.sql. This file covers the app half only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import { effectivePermissions, type Permission } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sessionState = {
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
  // undefined → can() falls back to the static role defaults. Tests that
  // exercise the anti-escalation guard set an explicit set that LACKS the
  // permission under test.
  permissions: undefined as Set<Permission> | undefined,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastPermissionsChanged: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      permissions: sessionState.permissions,
      supabase: stubHolder.stub!.client,
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(),
    })),
  };
});

import { setRolePermissionOverrideAction, setUserPermissionOverrideAction } from './permissions';

/** The permission an admin does NOT hold: owner-reserved. */
const OWNER_ONLY: Permission = 'billing:manage';
/** A permission an admin DOES hold by default. */
const ADMIN_HELD: Permission = 'stock:adjust';

/** Every override-table chain the stub recorded, per op. */
function chainCount(table: string, op: 'select' | 'insert' | 'update' | 'delete'): number {
  return (stubHolder.stub!.chainsAll.get(`${table}.${op}`) ?? []).length;
}

function freshStub() {
  // setUserPermissionOverrideAction verifies the target is an accepted,
  // non-owner member of this org before writing.
  return makeSupabaseStub({
    'organization_members.select': { data: { role: 'staff' }, error: null },
  });
}

describe('permission override CLEAR is anti-escalation gated (MED-14)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    sessionState.permissions = undefined;
    stubHolder.stub = freshStub();
  });

  // ── The fix: clears are gated ────────────────────────────────────────────

  it('denies an admin clearing a USER override for a permission they lack, and writes nothing', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]); // lacks OWNER_ONLY
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: OWNER_ONLY,
      granted: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    // The guard runs BEFORE the member lookup, so nothing touched the DB at all.
    expect(chainCount('user_permission_overrides', 'delete')).toBe(0);
    expect(stubHolder.stub!.fromCalls).not.toContain('user_permission_overrides');
  });

  it('denies an admin clearing a ROLE override for a permission they lack, and writes nothing', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]);
    const result = await setRolePermissionOverrideAction({
      role: 'admin',
      permission: OWNER_ONLY,
      granted: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(chainCount('role_permission_overrides', 'delete')).toBe(0);
    expect(stubHolder.stub!.fromCalls).not.toContain('role_permission_overrides');
  });

  // ── The outage half: legitimate clears still work ────────────────────────

  it('ALLOWS an admin clearing an override for a permission they DO hold', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]);
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: ADMIN_HELD,
      granted: null,
    });
    expect(result.ok).toBe(true);
    expect(chainCount('user_permission_overrides', 'delete')).toBe(1);
  });

  it('ALLOWS the OWNER to clear any override — the lockout escape hatch', async () => {
    sessionState.role = 'owner';
    // The escape hatch does NOT live in can() — can() just reads
    // ctx.permissions. It lives in effectivePermissions(), which short-circuits
    // role 'owner' to the FULL set (and loadEffectivePermissions() returns that
    // without a DB round-trip). So this is the owner context the app actually
    // produces; building one by hand with a narrowed set would be testing a
    // state that cannot occur, and would "prove" a lockout that does not exist.
    sessionState.permissions = effectivePermissions('owner');
    expect(sessionState.permissions.has(OWNER_ONLY)).toBe(true);
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: OWNER_ONLY,
      granted: null,
    });
    expect(result.ok).toBe(true);
    expect(chainCount('user_permission_overrides', 'delete')).toBe(1);
  });

  it('ALLOWS a REVOKE (granted=false) for a permission the actor lacks — it cannot escalate', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]);
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: OWNER_ONLY,
      granted: false,
    });
    expect(result.ok).toBe(true);
    // A revoke is an upsert, not a delete.
    expect(chainCount('user_permission_overrides', 'insert')).toBe(1);
    expect(chainCount('user_permission_overrides', 'delete')).toBe(0);
  });

  // ── The pre-existing rule must be unchanged by the polarity flip ─────────

  it('still denies a GRANT (granted=true) for a permission the actor lacks', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]);
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: OWNER_ONLY,
      granted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(chainCount('user_permission_overrides', 'insert')).toBe(0);
  });

  it('still ALLOWS a GRANT for a permission the actor holds', async () => {
    sessionState.permissions = new Set<Permission>([ADMIN_HELD]);
    const result = await setUserPermissionOverrideAction({
      userId: '00000000-0000-0000-0000-0000000000a1',
      permission: ADMIN_HELD,
      granted: true,
    });
    expect(result.ok).toBe(true);
    expect(chainCount('user_permission_overrides', 'insert')).toBe(1);
  });
});
