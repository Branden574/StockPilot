/**
 * Writing a restriction over an existing restriction on a permission the
 * actor does not hold.
 *
 * WHY THIS FILE EXISTS
 *   The database asks for the same permission the app asks before a
 *   restriction changes: the *_overrides_update policies ask has_permission()
 *   of a granted=false row, as the *_overrides_delete policies do since 0322.
 *   The Roles page always saves an explicit true/false with an upsert, and the
 *   upsert's ON CONFLICT branch meets that rule even when the value does not
 *   change. So an admin who lacks a permission and saves "restricted" over a
 *   row that already says restricted (a page opened before someone else made
 *   the same change) gets 42501 from the database. After requireConfigurer and
 *   assertCanGrant that is the only 42501 a restriction write can meet.
 *
 *   The action re-reads the row with the actor's own client:
 *     already restricted  -> success, no audit row and no broadcast (nothing
 *                            changed), as before;
 *     anything else       -> the plain sentence below.
 *   A platform-managed key keeps its own refusal, and a refused grant is not
 *   absorbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';
import { audit } from '@/server/services/audit';
import { broadcastPermissionsChanged } from '@/lib/realtime/broadcast';
import { revalidatePath } from 'next/cache';

import { PLATFORM_MANAGED_PERMISSION_COPY, type Permission } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sessionState = {
  role: 'admin' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
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
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(),
    })),
  };
});

import { setRolePermissionOverrideAction, setUserPermissionOverrideAction } from './permissions';

/** A permission this admin does not hold. */
const LACKED: Permission = 'members:remove';
/** A permission this admin holds. */
const HELD: Permission = 'stock:adjust';
const MEMBER = '00000000-0000-0000-0000-0000000000a1';
const SENTENCE = 'You can only change restrictions on permissions you have yourself.';

/** What the database answers an upsert its UPDATE rule refuses. */
const REFUSED: QueryResult = {
  data: null,
  error: {
    message: 'new row violates row-level security policy (USING expression) for table',
    code: '42501',
  },
};

function stub(
  table: 'user_permission_overrides' | 'role_permission_overrides',
  reread: QueryResult,
) {
  return makeSupabaseStub({
    // setUserPermissionOverrideAction checks the target is an accepted,
    // non-owner member first.
    'organization_members.select': { data: { role: 'staff' }, error: null },
    [`${table}.insert`]: REFUSED,
    [`${table}.select`]: reread,
  });
}

/** The re-read's filters, as [method, column, value]. */
function rereadFilters(table: string): unknown[][] {
  const chains = stubHolder.stub!.chainsAll.get(`${table}.select`) ?? [];
  const args = stubHolder.stub!.chainArgsAll.get(`${table}.select`) ?? [];
  expect(chains).toHaveLength(1);
  return chains[0]!.map((m, i) => [m, ...(args[0]![i] ?? [])]);
}

function nothingAnnounced() {
  expect(audit).not.toHaveBeenCalled();
  expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

describe('a restriction re-written over an existing restriction on a permission the actor lacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'admin';
    sessionState.permissions = new Set<Permission>([HELD]); // lacks LACKED
  });

  it('person: already restricted -> success with no audit row and no broadcast', async () => {
    stubHolder.stub = stub('user_permission_overrides', {
      data: [{ granted: false }],
      error: null,
    });
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(result).toEqual({ ok: true, data: null });
    nothingAnnounced();
    // The re-read is the same row, through the actor's own client.
    expect(rereadFilters('user_permission_overrides')).toEqual([
      ['select', 'granted'],
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'user_id', MEMBER],
      ['eq', 'permission', LACKED],
    ]);
  });

  it('role: already restricted -> success with no audit row and no broadcast', async () => {
    stubHolder.stub = stub('role_permission_overrides', {
      data: [{ granted: false }],
      error: null,
    });
    const result = await setRolePermissionOverrideAction({
      role: 'admin',
      permission: LACKED,
      granted: false,
    });
    expect(result).toEqual({ ok: true, data: null });
    nothingAnnounced();
    expect(rereadFilters('role_permission_overrides')).toEqual([
      ['select', 'granted'],
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'role', 'admin'],
      ['eq', 'permission', LACKED],
    ]);
  });

  it.each([
    ['the row is a grant', { data: [{ granted: true }], error: null }],
    ['there is no row', { data: [], error: null }],
    ['the answer is not a list', { data: null, error: null }],
    ['the re-read fails', { data: null, error: { message: 'boom', code: 'XX000' } }],
  ] as const)('person: %s -> the plain sentence, nothing announced', async (_label, reread) => {
    stubHolder.stub = stub('user_permission_overrides', reread);
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toBe(SENTENCE);
    }
    nothingAnnounced();
  });

  it.each([
    ['the row is a grant', { data: [{ granted: true }], error: null }],
    ['there is no row', { data: [], error: null }],
    ['the answer is not a list', { data: null, error: null }],
  ] as const)('role: %s -> the plain sentence, nothing announced', async (_label, reread) => {
    stubHolder.stub = stub('role_permission_overrides', reread);
    const result = await setRolePermissionOverrideAction({
      role: 'staff',
      permission: LACKED,
      granted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toBe(SENTENCE);
    }
    nothingAnnounced();
  });

  it('a platform-managed refusal keeps its own words and is not re-read', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': { data: { role: 'staff' }, error: null },
      'user_permission_overrides.insert': {
        data: null,
        error: {
          message: 'This permission is managed by StockPilot support.',
          code: '42501',
          hint: 'permission_platform_managed',
        },
      },
      'user_permission_overrides.select': { data: [{ granted: false }], error: null },
    });
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toBe(PLATFORM_MANAGED_PERMISSION_COPY);
    }
    expect(stubHolder.stub.chainsAll.get('user_permission_overrides.select')).toBeUndefined();
    nothingAnnounced();
  });

  it('a refused grant is not absorbed and is not re-read', async () => {
    // assertCanGrant passed (the actor holds HELD); the database refused anyway.
    stubHolder.stub = stub('user_permission_overrides', { data: [{ granted: true }], error: null });
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: HELD,
      granted: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(stubHolder.stub.chainsAll.get('user_permission_overrides.select')).toBeUndefined();
    nothingAnnounced();
  });

  it('another database error on a restriction is not re-read', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': { data: { role: 'staff' }, error: null },
      'user_permission_overrides.insert': {
        data: null,
        error: { message: 'insert or update violates foreign key constraint', code: '23503' },
      },
      'user_permission_overrides.select': { data: [{ granted: false }], error: null },
    });
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('internal_error');
    expect(stubHolder.stub.chainsAll.get('user_permission_overrides.select')).toBeUndefined();
    nothingAnnounced();
  });

  it('a restriction the database accepts is audited and broadcast as before', async () => {
    stubHolder.stub = makeSupabaseStub({
      'organization_members.select': { data: { role: 'staff' }, error: null },
    });
    const result = await setUserPermissionOverrideAction({
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(result).toEqual({ ok: true, data: null });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(broadcastPermissionsChanged).toHaveBeenCalledWith('org-1', {
      userId: MEMBER,
      permission: LACKED,
      granted: false,
    });
    expect(stubHolder.stub.chainsAll.get('user_permission_overrides.select')).toBeUndefined();
  });
});
