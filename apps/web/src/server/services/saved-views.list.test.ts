import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * SavedViewsService.list() skips the warehouse-access lookup for
 * manager-and-above, and returns exactly what it returned before.
 *
 * getWarehouseAccess answers hasAllAccess = true for owner/admin/manager on
 * its isManagerOrAbove(role) test whatever its read returns, so the shared-view
 * warehouse filter kept every view for them. Called with the service ctx, that
 * lookup was a direct `warehouses` read issued AFTER the saved_views read: two
 * Supabase calls in series in front of the Items/Books table. These tests run
 * the REAL getWarehouseAccess over mocked reads and compare every role against
 * the previous always-look-up code.
 */

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(),
  ServiceError: class ServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
// getWarehouseAccess's zero-arg fallbacks; list() always passes its ctx, so
// neither may be reached.
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached from list()');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('the cookie client must not be used when a ctx client is supplied');
  }),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => {
    throw new Error('a ctx-supplied client bypasses the request cache');
  }),
  readWarehousesForRequest: vi.fn(async () => {
    throw new Error('a ctx-supplied client bypasses the request cache');
  }),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import type { ServiceContext } from './context';

import { SavedViewsService, type SavedView } from './saved-views';

const ME = 'u-me';
const OTHER = 'u-other';

/** Rows as saved_views returns them. Own views are always kept; shared views
 *  pinned to a warehouse the viewer cannot read are dropped. */
const ROWS = [
  view('v-own-wh2', ME, false, { warehouseId: 'wh-2' }),
  view('v-own-none', ME, false, {}),
  view('v-shared-none', OTHER, true, { stock: 'low' }),
  view('v-shared-wh1', OTHER, true, { warehouseId: 'wh-1' }),
  view('v-shared-wh2', OTHER, true, { warehouseId: 'wh-2' }),
  view('v-shared-wh999', OTHER, true, { warehouseId: 'wh-999' }),
  view('v-shared-null', OTHER, true, { warehouseId: null }),
];

function view(id: string, userId: string, isShared: boolean, state: Record<string, unknown>) {
  return {
    id,
    name: id,
    scope: 'inventory',
    state,
    sort_order: 0,
    created_at: '2026-09-01T00:00:00Z',
    is_shared: isShared,
    user_id: userId,
  };
}

type RoleCase = { label: string; role: string; allWarehouses: boolean };
const ROLES: RoleCase[] = [
  { label: 'owner', role: 'owner', allWarehouses: false },
  { label: 'admin', role: 'admin', allWarehouses: false },
  { label: 'manager', role: 'manager', allWarehouses: false },
  { label: 'staff', role: 'staff', allWarehouses: false },
  { label: 'viewer', role: 'viewer', allWarehouses: false },
  { label: 'staff + all_warehouses (0280)', role: 'staff', allWarehouses: true },
  { label: 'viewer + all_warehouses (0280)', role: 'viewer', allWarehouses: true },
];

function ctxFor(role: RoleCase): { ctx: ServiceContext; stub: SupabaseStub } {
  const stub = makeSupabaseStub({
    'saved_views.select': { data: ROWS, error: null },
    'warehouses.select': { data: [{ id: 'wh-1' }, { id: 'wh-2' }], error: null },
    'user_warehouse_assignments.select': {
      data: [{ warehouse_id: 'wh-1', is_primary: true }],
      error: null,
    },
    'organization_members.select': {
      data: [{ all_warehouses: role.allWarehouses }],
      error: null,
    },
  });
  const ctx = {
    organizationId: 'org-1',
    userId: ME,
    role: role.role,
    supabase: stub.client,
  } as unknown as ServiceContext;
  return { ctx, stub };
}

/** list()'s filter as it read before: the access lookup for every role. The
 *  fixture states are already in sanitized shape, so the rows map 1:1. */
async function previousList(ctx: ServiceContext): Promise<SavedView[]> {
  const access = await getWarehouseAccess(ctx);
  return ROWS.map((r) => ({
    id: r.id,
    name: r.name,
    scope: 'inventory' as const,
    state: r.state as SavedView['state'],
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    isShared: r.is_shared,
    ownerId: r.user_id,
  })).filter((v) => {
    if (v.ownerId === ctx.userId) return true;
    const wh = v.state.warehouseId;
    if (!wh) return true;
    return access.hasAllAccess || access.readableIds.includes(wh);
  });
}

const ids = (views: SavedView[]) => views.map((v) => v.id);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SavedViewsService.list: manager-and-above skip the warehouse lookup', () => {
  it.each(ROLES)('$label sees exactly the views the always-look-up code returned', async (role) => {
    const { ctx: refCtx } = ctxFor(role);
    const before = await previousList(refCtx);

    const { ctx } = ctxFor(role);
    const after = await new SavedViewsService(ctx).list('inventory');

    expect(ids(after)).toEqual(ids(before));
  });

  it.each(ROLES.filter((r) => ['owner', 'admin', 'manager'].includes(r.role)))(
    '$label: one Supabase read (saved_views), no warehouses read after it',
    async (role) => {
      const { ctx, stub } = ctxFor(role);
      const views = await new SavedViewsService(ctx).list('inventory');

      expect(stub.fromCalls).toEqual(['saved_views']);
      // All access: every shared view is kept, whatever warehouse it names.
      expect(ids(views)).toEqual(ROWS.map((r) => r.id));
    },
  );

  it.each(ROLES.filter((r) => !['owner', 'admin', 'manager'].includes(r.role)))(
    '$label keeps the lookup (assignments + membership) and its filtering',
    async (role) => {
      const { ctx, stub } = ctxFor(role);
      const views = await new SavedViewsService(ctx).list('inventory');

      expect(stub.fromCalls).toEqual(
        expect.arrayContaining([
          'saved_views',
          'user_warehouse_assignments',
          'organization_members',
        ]),
      );
      if (role.allWarehouses) {
        expect(ids(views)).toEqual(ROWS.map((r) => r.id));
      } else {
        // wh-2 and wh-999 are not theirs: those two SHARED views drop; their
        // own wh-2 view stays.
        expect(ids(views)).toEqual([
          'v-own-wh2',
          'v-own-none',
          'v-shared-none',
          'v-shared-wh1',
          'v-shared-null',
        ]);
      }
    },
  );

  it('a saved_views read error still throws for every role', async () => {
    for (const role of ROLES) {
      const stub = makeSupabaseStub({
        'saved_views.select': { data: null, error: { message: 'boom' } },
      });
      const ctx = {
        organizationId: 'org-1',
        userId: ME,
        role: role.role,
        supabase: stub.client,
      } as unknown as ServiceContext;
      await expect(new SavedViewsService(ctx).list('inventory')).rejects.toThrow('boom');
    }
  });
});
