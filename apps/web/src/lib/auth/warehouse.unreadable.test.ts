import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

/**
 * getWarehouseAccess: a read that FAILED denies; it is never read as a list.
 *
 * supabase-js resolves a failed query as `{ data: null, error }`, and this
 * helper used to take `data ?? []`, so "the read failed" and "you have no
 * rows" produced the same answer and the mobile snapshot, which caught a
 * failure as hasAllAccess: true, had no way to tell them apart either. These
 * tests pin, for every role:
 *
 *   1. each read that feeds the answer, when it returns an error, yields the
 *      unreadable answer: no readable or writable warehouse for staff/viewer,
 *      hasAllAccess still by ROLE (and an empty list) for manager-and-above;
 *   2. the helpers built on it (assertWarehouseAccess, forcedWarehouseId)
 *      deny on that answer;
 *   3. every answer built from reads that succeeded is exactly what it was,
 *      including a genuinely empty assignment list, and carries no flag.
 */

const cacheRead = vi.hoisted(() => vi.fn());
vi.mock('@/lib/dashboard/request-cache', () => ({ readWarehousesForRequest: cacheRead }));
// Every test passes its own ctx and client, so neither fallback may be reached.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached: every test passes a ctx');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('the cookie client must not be created: every test passes a client');
  }),
}));

import {
  assertWarehouseAccess,
  ForbiddenError,
  forcedWarehouseId,
  getWarehouseAccess,
  type WarehouseAccess,
} from './warehouse';

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

const MANAGERS: Role[] = ['owner', 'admin', 'manager'];
const SCOPED: Role[] = ['staff', 'viewer'];

/** What PostgREST hands back for a statement that did not run. */
const FAILED: QueryResult = {
  data: null,
  error: { message: 'canceling statement due to statement timeout', code: '57014' },
};

const ASSIGNMENTS: QueryResult = {
  data: [
    { warehouse_id: 'wh-b', is_primary: true },
    { warehouse_id: 'wh-c', is_primary: false },
  ],
  error: null,
};
const member = (allWarehouses: boolean): QueryResult => ({
  data: [{ all_warehouses: allWarehouses }],
  error: null,
});

function client(results: Record<string, QueryResult>) {
  return makeSupabaseStub(results);
}

type Ctx = NonNullable<Parameters<typeof getWarehouseAccess>[0]>;

/** A Bearer / service context: its own client, not the request's cookie client. */
const bearerCtx = (role: Role, supabase: unknown): Ctx =>
  ({ organizationId: 'org-1', userId: 'u-1', role, supabase }) as Ctx;

/** A withContext() context: its client IS the request's cookie client. */
const cookieCtx = (role: Role, supabase: unknown): Ctx =>
  ({ organizationId: 'org-1', userId: 'u-1', role, supabase, cookieClient: supabase }) as Ctx;

const DENIED_SCOPED: WarehouseAccess = {
  readableIds: [],
  writableIds: [],
  hasAllAccess: false,
  primaryWarehouseId: null,
  unreadable: true,
};
const UNREADABLE_MANAGER: WarehouseAccess = {
  readableIds: [],
  writableIds: [],
  hasAllAccess: true,
  primaryWarehouseId: null,
  unreadable: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  cacheRead.mockResolvedValue({
    rows: [
      { id: 'wh-a', name: 'Alpha' },
      { id: 'wh-b', name: 'Bravo' },
    ],
    failed: false,
  });
});

// ── 1. Each failed read denies ──────────────────────────────────────────

describe('staff / viewer: either read failing denies the whole answer', () => {
  const cases: Array<{ label: string; results: Record<string, QueryResult> }> = [
    {
      label: 'assignments read failed',
      results: {
        'user_warehouse_assignments.select': FAILED,
        'organization_members.select': member(false),
      },
    },
    {
      label: 'membership read failed (assignments fine)',
      results: {
        'user_warehouse_assignments.select': ASSIGNMENTS,
        'organization_members.select': FAILED,
      },
    },
    {
      label: 'both reads failed',
      results: {
        'user_warehouse_assignments.select': FAILED,
        'organization_members.select': FAILED,
      },
    },
    {
      // The 0280 flag came back TRUE, but half an answer is not an answer: the
      // flag never turns a failed assignments read into all access.
      label: 'assignments read failed while the all-warehouses flag reads true',
      results: {
        'user_warehouse_assignments.select': FAILED,
        'organization_members.select': member(true),
      },
    },
  ];

  for (const role of SCOPED) {
    for (const c of cases) {
      it(`${role}: ${c.label} -> no readable, no writable, not all access`, async () => {
        const stub = client(c.results);
        const access = await getWarehouseAccess(bearerCtx(role, stub.client));
        expect(access).toStrictEqual(DENIED_SCOPED);
      });
    }
  }

  it('the same holds on the request cookie client (withContext ctx)', async () => {
    const stub = client({
      'user_warehouse_assignments.select': FAILED,
      'organization_members.select': member(false),
    });
    const access = await getWarehouseAccess(cookieCtx('staff', stub.client));
    expect(access).toStrictEqual(DENIED_SCOPED);
    // Staff never read the warehouses list, cached or not.
    expect(cacheRead).not.toHaveBeenCalled();
  });

  it('logs which read failed, without the rows', async () => {
    const stub = client({
      'user_warehouse_assignments.select': FAILED,
      'organization_members.select': member(false),
    });
    await getWarehouseAccess(bearerCtx('staff', stub.client));
    expect(console.error).toHaveBeenCalledWith(
      '[getWarehouseAccess] user_warehouse_assignments read failed:',
      'canceling statement due to statement timeout',
    );
  });
});

describe('owner / admin / manager: a failed warehouses list is unreadable, and the ROLE still decides', () => {
  it.each(MANAGERS)(
    '%s on the cookie client: the shared request-cached read failed',
    async (role) => {
      cacheRead.mockResolvedValue({ rows: [], failed: true });
      const own = client({});
      const access = await getWarehouseAccess(cookieCtx(role, own.client));
      expect(cacheRead).toHaveBeenCalledWith('org-1');
      expect(own.fromCalls).toEqual([]);
      expect(access).toStrictEqual(UNREADABLE_MANAGER);
    },
  );

  it.each(MANAGERS)('%s with a Bearer client: its own warehouses read failed', async (role) => {
    const bearer = client({ 'warehouses.select': FAILED });
    const access = await getWarehouseAccess(bearerCtx(role, bearer.client));
    expect(bearer.fromCalls).toEqual(['warehouses']);
    expect(cacheRead).not.toHaveBeenCalled();
    expect(access).toStrictEqual(UNREADABLE_MANAGER);
  });
});

describe('a read that THROWS rejects; it never resolves to an access answer', () => {
  it.each<Role>(['manager', 'staff', 'viewer'])('%s', async (role) => {
    const throwing = {
      from: () => {
        throw new Error('fetch failed');
      },
    };
    await expect(getWarehouseAccess(bearerCtx(role, throwing))).rejects.toThrow('fetch failed');
  });
});

// ── 2. The helpers built on it deny ─────────────────────────────────────

describe('assertWarehouseAccess and forcedWarehouseId deny on an unreadable answer', () => {
  const failedStaff = () =>
    bearerCtx(
      'staff',
      client({
        'user_warehouse_assignments.select': FAILED,
        'organization_members.select': member(false),
      }).client,
    );

  it.each<'read' | 'write'>(['read', 'write'])(
    'staff %s access to a warehouse they ARE assigned to is refused while the assignments are unreadable',
    async (op) => {
      await expect(assertWarehouseAccess('wh-b', op, failedStaff())).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    },
  );

  it('forcedWarehouseId refuses instead of returning null (which would mean "no pin")', async () => {
    await expect(forcedWarehouseId(failedStaff())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a manager is still allowed: the role alone grants every warehouse, as before', async () => {
    const bearer = client({ 'warehouses.select': FAILED });
    await expect(
      assertWarehouseAccess('wh-z', 'write', bearerCtx('manager', bearer.client)),
    ).resolves.toBeUndefined();
  });
});

// ── 3. Success answers are unchanged, for every role ────────────────────

describe('reads that succeed give exactly the answers they always did', () => {
  it.each(MANAGERS)('%s on the cookie client', async (role) => {
    const own = client({});
    const access = await getWarehouseAccess(cookieCtx(role, own.client));
    expect(access).toStrictEqual({
      readableIds: ['wh-a', 'wh-b'],
      writableIds: ['wh-a', 'wh-b'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-a',
    });
  });

  it.each(MANAGERS)('%s with a Bearer client', async (role) => {
    const bearer = client({
      'warehouses.select': { data: [{ id: 'wh-b' }, { id: 'wh-c' }], error: null },
    });
    const access = await getWarehouseAccess(bearerCtx(role, bearer.client));
    expect(access).toStrictEqual({
      readableIds: ['wh-b', 'wh-c'],
      writableIds: ['wh-b', 'wh-c'],
      hasAllAccess: true,
      primaryWarehouseId: 'wh-b',
    });
  });

  it.each(MANAGERS)(
    '%s in an org with no warehouses: an empty list, and NOT flagged',
    async (role) => {
      const bearer = client({ 'warehouses.select': { data: [], error: null } });
      const access = await getWarehouseAccess(bearerCtx(role, bearer.client));
      expect(access).toStrictEqual({
        readableIds: [],
        writableIds: [],
        hasAllAccess: true,
        primaryWarehouseId: null,
      });
    },
  );

  it('staff: readable + writable = assignments, primary = the flagged row', async () => {
    const stub = client({
      'user_warehouse_assignments.select': ASSIGNMENTS,
      'organization_members.select': member(false),
    });
    expect(await getWarehouseAccess(bearerCtx('staff', stub.client))).toStrictEqual({
      readableIds: ['wh-b', 'wh-c'],
      writableIds: ['wh-b', 'wh-c'],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-b',
    });
  });

  it('viewer: readable = assignments, writable = []', async () => {
    const stub = client({
      'user_warehouse_assignments.select': ASSIGNMENTS,
      'organization_members.select': member(false),
    });
    expect(await getWarehouseAccess(bearerCtx('viewer', stub.client))).toStrictEqual({
      readableIds: ['wh-b', 'wh-c'],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: 'wh-b',
    });
  });

  it.each(SCOPED)(
    '%s with the 0280 all-warehouses flag: hasAllAccess, assignments kept',
    async (role) => {
      const stub = client({
        'user_warehouse_assignments.select': ASSIGNMENTS,
        'organization_members.select': member(true),
      });
      const access = await getWarehouseAccess(bearerCtx(role, stub.client));
      expect(access.hasAllAccess).toBe(true);
      expect(access.readableIds).toEqual(['wh-b', 'wh-c']);
      expect(access).not.toHaveProperty('unreadable');
    },
  );

  it.each(SCOPED)(
    '%s with genuinely no assignments: empty, and NOT flagged as unreadable',
    async (role) => {
      const stub = client({
        'user_warehouse_assignments.select': { data: [], error: null },
        'organization_members.select': { data: [], error: null },
      });
      expect(await getWarehouseAccess(bearerCtx(role, stub.client))).toStrictEqual({
        readableIds: [],
        writableIds: [],
        hasAllAccess: false,
        primaryWarehouseId: null,
      });
    },
  );

  it('forcedWarehouseId still pins a staffer to their primary warehouse', async () => {
    const stub = client({
      'user_warehouse_assignments.select': ASSIGNMENTS,
      'organization_members.select': member(false),
    });
    await expect(forcedWarehouseId(bearerCtx('staff', stub.client))).resolves.toBe('wh-b');
  });
});
