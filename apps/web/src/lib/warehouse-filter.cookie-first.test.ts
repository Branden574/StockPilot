import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * getActiveWarehouseFilter() reads the cookie BEFORE any warehouse lookup.
 *
 * With no cookie every role resolves null, so awaiting getWarehouseAccess()
 * first bought nothing and put a Supabase read (the `warehouses` list for a
 * manager, assignments + membership for staff/viewer) in front of the Items
 * and Books table on every render. These tests run the REAL
 * getWarehouseAccess (lib/auth/warehouse.ts) over mocked reads and check, for
 * every role x cookie case, that the answer is exactly what the previous
 * access-first ordering returned, and that the no-cookie case reads nothing.
 */

const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const holder = vi.hoisted(() => ({
  role: 'manager' as string,
  supabase: null as unknown,
}));

const requireOrgContext = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ requireOrgContext }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.supabase),
}));

const getWarehousesForRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/dashboard/request-cache', () => ({ getWarehousesForRequest }));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { getActiveWarehouseFilter, WAREHOUSE_FILTER_COOKIE } from './warehouse-filter';

/** The org has two live warehouses; staff are assigned to wh-1 only. */
const ORG_WAREHOUSES = [
  { id: 'wh-1', name: 'North' },
  { id: 'wh-2', name: 'South' },
];

/** The function exactly as it read before the reorder (access FIRST). */
async function previousGetActiveWarehouseFilter(): Promise<string | null> {
  const access = await getWarehouseAccess();
  if (!access.hasAllAccess) return null;
  const raw = cookieGet(WAREHOUSE_FILTER_COOKIE)?.value;
  if (!raw) return null;
  if (!access.readableIds.includes(raw)) return null;
  return raw;
}

type RoleCase = { label: string; role: string; allWarehouses: boolean };

const ROLES: RoleCase[] = [
  { label: 'owner', role: 'owner', allWarehouses: false },
  { label: 'admin', role: 'admin', allWarehouses: false },
  { label: 'manager', role: 'manager', allWarehouses: false },
  { label: 'staff', role: 'staff', allWarehouses: false },
  { label: 'viewer', role: 'viewer', allWarehouses: false },
  // The 0280 all-warehouses membership flag: scoped by role, hasAllAccess.
  { label: 'staff + all_warehouses', role: 'staff', allWarehouses: true },
  { label: 'viewer + all_warehouses', role: 'viewer', allWarehouses: true },
];

const COOKIES: Array<{ label: string; value: string | undefined }> = [
  { label: 'absent', value: undefined },
  { label: 'empty', value: '' },
  { label: 'valid for everyone (wh-1)', value: 'wh-1' },
  { label: 'valid for managers only (wh-2)', value: 'wh-2' },
  { label: 'invalid (wh-999)', value: 'wh-999' },
];

/** What the filter must resolve to — the previous ordering's answers. */
function expected(role: RoleCase, cookie: string | undefined): string | null {
  if (!cookie) return null;
  const manager = ['owner', 'admin', 'manager'].includes(role.role);
  if (!manager && !role.allWarehouses) return null;
  const readable = manager ? ['wh-1', 'wh-2'] : ['wh-1'];
  return readable.includes(cookie) ? cookie : null;
}

let stub: SupabaseStub;

function setUp(role: RoleCase, cookie: string | undefined) {
  holder.role = role.role;
  stub = makeSupabaseStub({
    'user_warehouse_assignments.select': {
      data: [{ warehouse_id: 'wh-1', is_primary: true }],
      error: null,
    },
    'organization_members.select': {
      data: [{ all_warehouses: role.allWarehouses }],
      error: null,
    },
  });
  holder.supabase = stub.client;
  cookieGet.mockImplementation((name) =>
    name === WAREHOUSE_FILTER_COOKIE && cookie !== undefined ? { value: cookie } : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgContext.mockImplementation(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: holder.role,
  }));
  getWarehousesForRequest.mockResolvedValue(ORG_WAREHOUSES);
});

describe('getActiveWarehouseFilter: cookie first, same answers', () => {
  for (const role of ROLES) {
    for (const cookie of COOKIES) {
      it(`${role.label}, cookie ${cookie.label}: identical to the access-first ordering`, async () => {
        setUp(role, cookie.value);
        const before = await previousGetActiveWarehouseFilter();

        setUp(role, cookie.value);
        const after = await getActiveWarehouseFilter();

        expect(after).toBe(before);
        expect(after).toBe(expected(role, cookie.value));
      });
    }
  }

  it.each(ROLES)('$label with no cookie resolves null without any warehouse read', async (role) => {
    setUp(role, undefined);
    vi.clearAllMocks();

    await expect(getActiveWarehouseFilter()).resolves.toBeNull();

    // No access lookup at all: not the org context it starts from, not the
    // request-cached warehouses list, not a single table read.
    expect(requireOrgContext).not.toHaveBeenCalled();
    expect(getWarehousesForRequest).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });

  it('a present cookie is still validated against the readable ids', async () => {
    setUp(ROLES[2]!, 'wh-2');
    await expect(getActiveWarehouseFilter()).resolves.toBe('wh-2');
    expect(getWarehousesForRequest).toHaveBeenCalledWith('org-1');

    setUp(ROLES[3]!, 'wh-1');
    // Plain staff: never a view filter, even for their own warehouse.
    await expect(getActiveWarehouseFilter()).resolves.toBeNull();
    expect(stub.fromCalls).toEqual(
      expect.arrayContaining(['user_warehouse_assignments', 'organization_members']),
    );
  });
});
