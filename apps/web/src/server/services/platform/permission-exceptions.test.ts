import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PermissionExceptionsService: StockPilot support's one write path for a
 * platform-managed permission (orders:manage_catalog_visibility, migration
 * 0413) and the one batched read the console's Users tab needs.
 *
 *   - set() re-verifies the actor from GoTrue against the allowlist (never
 *     trusting the caller), hands the SQL function the VERIFIED email, maps
 *     its refusals (a stale row is a conflict, never "not authorized"), and
 *     pings perms:{org} only when something changed;
 *   - listForMembers() reads the key's and orders:request's user rows for one
 *     page of members, the organization's orders:request role rows and the
 *     Orders module, in one round, and throws on any failed read.
 *
 * Synthetic data only: example.org addresses, made-up ids.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const OTHER = '22222222-2222-4222-8222-222222222223';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ADMIN_EMAIL = 'support-admin@example.org';
const KEY = 'orders:manage_catalog_visibility';

const getUserById = vi.fn();
const rpc = vi.fn();
const broadcastPermissionsChanged = vi.fn(async (..._a: unknown[]) => {});
const reportError = vi.fn(async (..._a: unknown[]) => {});

type Read = { data: unknown; error: { message: string } | null };
const reads: Record<string, Read> = {};
const fromCalls: Array<{ table: string; calls: Array<[string, unknown[]]> }> = [];

vi.mock('server-only', () => ({}));
vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/realtime/broadcast', () => ({
  broadcastPermissionsChanged: (...a: unknown[]) => broadcastPermissionsChanged(...a),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  isPlatformAdmin: (email: string | null | undefined) =>
    typeof email === 'string' && email.toLowerCase() === ADMIN_EMAIL,
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { getUserById } },
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      const entry = { table, calls: [] as Array<[string, unknown[]]> };
      fromCalls.push(entry);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'not']) {
        q[m] = (...args: unknown[]) => {
          entry.calls.push([m, args]);
          return q;
        };
      }
      q.maybeSingle = () => {
        entry.calls.push(['maybeSingle', []]);
        const r = reads[table] ?? { data: null, error: null };
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return Promise.resolve({ ...r, data });
      };
      q.then = (resolve: (v: Read) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(reads[table] ?? { data: [], error: null }).then(resolve, reject);
      return q;
    },
  }),
}));

import { PermissionExceptionsService } from './permission-exceptions';

function actorIs(email: string | null) {
  getUserById.mockImplementation(async (id: string) =>
    id === ACTOR ? { data: { user: { id, email } }, error: null } : { data: { user: null }, error: { message: 'not found' } },
  );
}

const input = (patch: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  targetUserId: TARGET,
  state: 'deny' as const,
  expectedState: 'default' as const,
  actorUserId: ACTOR,
  ...patch,
});

beforeEach(() => {
  getUserById.mockReset();
  rpc.mockReset();
  broadcastPermissionsChanged.mockClear();
  reportError.mockClear();
  fromCalls.length = 0;
  for (const k of Object.keys(reads)) delete reads[k];
  actorIs(ADMIN_EMAIL);
});

describe('PermissionExceptionsService.set: who may call it', () => {
  it('refuses an actor GoTrue does not know, without calling the database', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'not found' } });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'not_authorized' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses an actor whose verified email is not on the allowlist, or who has none', async () => {
    actorIs('someone@example.org');
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'not_authorized' });
    actorIs(null);
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'not_authorized' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a key that is not platform-managed, and a state outside the three, before any read', async () => {
    expect(await PermissionExceptionsService.set(input({ permission: 'billing:manage' }))).toEqual({
      ok: false,
      code: 'invalid',
      field: 'permission',
    });
    expect(await PermissionExceptionsService.set(input({ state: 'grant' }))).toEqual({
      ok: false,
      code: 'invalid',
      field: 'state',
    });
    expect(await PermissionExceptionsService.set(input({ expectedState: '' }))).toEqual({
      ok: false,
      code: 'invalid',
      field: 'expectedState',
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('PermissionExceptionsService.set: the write', () => {
  it('calls the one SQL function with the GoTrue-verified email and the caller-chosen states', async () => {
    rpc.mockResolvedValue({ data: { before: 'default', after: 'deny', targetRole: 'manager', changed: true }, error: null });
    const res = await PermissionExceptionsService.set(input());
    expect(res).toEqual({ ok: true, before: 'default', after: 'deny', targetRole: 'manager', changed: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('platform_set_permission_exception', {
      p_organization_id: ORG,
      p_user_id: TARGET,
      p_permission: KEY,
      p_state: 'deny',
      p_expected_state: 'default',
      p_actor_user_id: ACTOR,
      p_actor_email: ADMIN_EMAIL,
    });
  });

  it.each([
    ['deny', false],
    ['allow', true],
    ['default', null],
  ] as const)('a change to %s pings perms:{org} for that member with granted %s', async (after, granted) => {
    rpc.mockResolvedValue({ data: { before: 'allow', after, targetRole: 'staff', changed: true }, error: null });
    await PermissionExceptionsService.set(input({ state: after, expectedState: 'allow' }));
    expect(broadcastPermissionsChanged).toHaveBeenCalledTimes(1);
    expect(broadcastPermissionsChanged).toHaveBeenCalledWith(ORG, { userId: TARGET, permission: KEY, granted });
  });

  it('a repeat of the current state changes nothing and pings nobody', async () => {
    rpc.mockResolvedValue({ data: { before: 'deny', after: 'deny', targetRole: 'owner', changed: false }, error: null });
    const res = await PermissionExceptionsService.set(input({ expectedState: 'deny' }));
    expect(res).toEqual({ ok: true, before: 'deny', after: 'deny', targetRole: 'owner', changed: false });
    expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
  });

  it('a lost compare-and-set is "changed" with the current state, never "not authorized"', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'permission_exception_changed', hint: 'permission_exception_changed', details: 'allow' },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'changed', current: 'allow' });
    expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a "changed" whose detail is unreadable still says changed, with no current state', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'permission_exception_changed', hint: 'permission_exception_changed', details: null },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'changed', current: null });
  });

  it('a target that is not an accepted member (or holds only an Act-as seat) is member_not_found', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'member_not_found', hint: 'member_not_found', details: null },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'member_not_found' });
  });

  it("the database's own validation refusals are invalid, with the field it named", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'permission_exception_invalid', hint: 'permission_exception_invalid', details: 'target' },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'invalid', field: 'target' });
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'permission_not_platform_managed', hint: 'permission_not_platform_managed', details: null },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'invalid', field: 'permission' });
  });

  it('an actor the database cannot find in auth.users (deleted after the check) is not_authorized', async () => {
    // 0413 review fix round: the database records the actor's own auth email
    // and refuses an unknown actor (detail 'actor'); that is no target error.
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'permission_exception_invalid', hint: 'permission_exception_invalid', details: 'actor' },
    });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'not_authorized' });
  });

  it.each(['55P03', '40P01', '57014'])('a lock wait or timeout (%s) is busy, not reported', async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'canceling statement', hint: null, details: null } });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'busy' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('anything else is internal and reported, and nothing is pinged', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found', hint: null, details: null } });
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'internal' });
    expect(reportError).toHaveBeenCalledTimes(1);
    rpc.mockRejectedValue(new Error('fetch failed'));
    expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'internal' });
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
  });

  it('a malformed answer is internal and reported, never trusted', async () => {
    for (const data of [
      null,
      { before: 'default', after: 'maybe', targetRole: 'staff', changed: true },
      { before: 'default', after: 'deny', targetRole: 'superuser', changed: true },
      { before: 'default', after: 'deny', targetRole: 'staff', changed: 'yes' },
    ]) {
      rpc.mockResolvedValue({ data, error: null });
      expect(await PermissionExceptionsService.set(input())).toEqual({ ok: false, code: 'internal' });
    }
    expect(reportError).toHaveBeenCalledTimes(4);
    expect(broadcastPermissionsChanged).not.toHaveBeenCalled();
  });
});

describe('PermissionExceptionsService.listForMembers', () => {
  it('reads one page of members in one round and fills every member, row or not', async () => {
    reads.user_permission_overrides = {
      data: [
        { user_id: TARGET, permission: KEY, granted: false },
        { user_id: TARGET, permission: 'orders:request', granted: true },
        { user_id: OTHER, permission: KEY, granted: true },
      ],
      error: null,
    };
    reads.role_permission_overrides = {
      data: [
        { role: 'viewer', granted: true },
        { role: 'staff', granted: false },
      ],
      error: null,
    };
    reads.organization_modules = { data: [{ module_id: 'orders' }], error: null };
    reads.organizations = { data: { all_modules_comp: false }, error: null };

    const third = '22222222-2222-4222-8222-222222222224';
    const res = await PermissionExceptionsService.listForMembers(ORG, [TARGET, OTHER, third, TARGET]);
    expect(res).toEqual({
      permission: KEY,
      ordersModuleEnabled: true,
      ordersRequestRoleOverrides: { viewer: true, staff: false },
      members: {
        [TARGET]: { exception: 'deny', ordersRequestOverride: true },
        [OTHER]: { exception: 'allow', ordersRequestOverride: null },
        [third]: { exception: 'default', ordersRequestOverride: null },
      },
    });

    const byTable = Object.fromEntries(fromCalls.map((c) => [c.table, c.calls]));
    expect(byTable.user_permission_overrides).toEqual([
      ['select', ['user_id, permission, granted']],
      ['eq', ['organization_id', ORG]],
      ['in', ['user_id', [TARGET, OTHER, third]]],
      ['in', ['permission', [KEY, 'orders:request']]],
    ]);
    expect(byTable.role_permission_overrides).toEqual([
      ['select', ['role, granted']],
      ['eq', ['organization_id', ORG]],
      ['eq', ['permission', 'orders:request']],
    ]);
    expect(byTable.organization_modules).toEqual([
      ['select', ['module_id']],
      ['eq', ['organization_id', ORG]],
      ['eq', ['module_id', 'orders']],
      ['eq', ['enabled', true]],
    ]);
    expect(byTable.organizations).toEqual([
      ['select', ['all_modules_comp']],
      ['eq', ['id', ORG]],
      ['maybeSingle', []],
    ]);
  });

  it('a comped organization has the Orders module on without a row', async () => {
    reads.organization_modules = { data: [], error: null };
    reads.organizations = { data: { all_modules_comp: true }, error: null };
    expect((await PermissionExceptionsService.listForMembers(ORG, [TARGET])).ordersModuleEnabled).toBe(true);
    reads.organizations = { data: { all_modules_comp: false }, error: null };
    expect((await PermissionExceptionsService.listForMembers(ORG, [TARGET])).ordersModuleEnabled).toBe(false);
  });

  it('a row for any other key or a role row that is not a role is ignored', async () => {
    reads.user_permission_overrides = { data: [{ user_id: TARGET, permission: 'billing:manage', granted: false }], error: null };
    reads.role_permission_overrides = { data: [{ role: 'superuser', granted: true }], error: null };
    const res = await PermissionExceptionsService.listForMembers(ORG, [TARGET]);
    expect(res.members[TARGET]).toEqual({ exception: 'default', ordersRequestOverride: null });
    expect(res.ordersRequestRoleOverrides).toEqual({});
  });

  it('no members: no member read, the organization facts still answered', async () => {
    reads.organization_modules = { data: [{ module_id: 'orders' }], error: null };
    const res = await PermissionExceptionsService.listForMembers(ORG, []);
    expect(res.members).toEqual({});
    expect(res.ordersModuleEnabled).toBe(true);
    expect(fromCalls.map((c) => c.table)).not.toContain('user_permission_overrides');
  });

  it('more than one page of members is refused (the Users tab shows 50)', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`);
    await expect(PermissionExceptionsService.listForMembers(ORG, ids)).rejects.toThrow(/at most 50/);
    expect(fromCalls).toEqual([]);
  });

  it.each(['user_permission_overrides', 'role_permission_overrides', 'organization_modules', 'organizations'])(
    'a failed %s read throws (the console shows the column as unavailable, never a guess)',
    async (table) => {
      reads[table] = { data: null, error: { message: 'timeout' } };
      await expect(PermissionExceptionsService.listForMembers(ORG, [TARGET])).rejects.toThrow(/timeout/);
    },
  );
});
