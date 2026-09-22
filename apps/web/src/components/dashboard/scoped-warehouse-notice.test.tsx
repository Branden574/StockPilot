import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * ScopedWarehouseNotice returns before any warehouse read for
 * manager-and-above, and renders exactly what it rendered before for every
 * role. The REAL getWarehouseAccess runs over mocked reads, so the notice and
 * the access rule it mirrors (isManagerOrAbove -> all access) are tested
 * together rather than against a restatement of each other.
 */

const holder = vi.hoisted(() => ({ role: 'manager', supabase: null as unknown }));

const requireOrgContext = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ requireOrgContext }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.supabase),
}));
const getWarehousesForRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest,
  // getWarehouseAccess reads the same cached list together with its outcome;
  // answered from the list mock so every assertion on that mock still holds.
  readWarehousesForRequest: async (organizationId: string) => ({
    rows: await getWarehousesForRequest(organizationId),
    failed: false,
  }),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { buildWarehouseScope, scopedWarehouseMessage } from '@/lib/warehouse-scope';

import { ScopedWarehouseNotice } from './scoped-warehouse-notice';

type RoleCase = {
  label: string;
  role: string;
  allWarehouses: boolean;
  assignments: string[];
};
const ROLES: RoleCase[] = [
  { label: 'owner', role: 'owner', allWarehouses: false, assignments: [] },
  { label: 'admin', role: 'admin', allWarehouses: false, assignments: [] },
  { label: 'manager', role: 'manager', allWarehouses: false, assignments: [] },
  { label: 'staff (one warehouse)', role: 'staff', allWarehouses: false, assignments: ['wh-1'] },
  { label: 'staff (no assignment)', role: 'staff', allWarehouses: false, assignments: [] },
  {
    label: 'viewer (two warehouses)',
    role: 'viewer',
    allWarehouses: false,
    assignments: ['wh-1', 'wh-2'],
  },
  {
    label: 'staff + all_warehouses (0280)',
    role: 'staff',
    allWarehouses: true,
    assignments: ['wh-1'],
  },
];

let stub: SupabaseStub;

function setUp(role: RoleCase) {
  holder.role = role.role;
  stub = makeSupabaseStub({
    'user_warehouse_assignments.select': {
      data: role.assignments.map((id, i) => ({ warehouse_id: id, is_primary: i === 0 })),
      error: null,
    },
    'organization_members.select': { data: [{ all_warehouses: role.allWarehouses }], error: null },
  });
  holder.supabase = stub.client;
}

/** The component exactly as it read before: access lookup first. */
async function previousNotice(): Promise<string | null> {
  const access = await getWarehouseAccess();
  if (access.hasAllAccess) return null;
  const ctx = await requireOrgContext();
  const warehouses = await getWarehousesForRequest(ctx.organizationId);
  return scopedWarehouseMessage(buildWarehouseScope(access, warehouses)) || null;
}

async function renderedText(): Promise<string | null> {
  const el = await ScopedWarehouseNotice({});
  if (el === null) return null;
  const { container } = render(el);
  return container.textContent || null;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgContext.mockImplementation(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: holder.role,
  }));
  getWarehousesForRequest.mockResolvedValue([
    { id: 'wh-1', name: 'North' },
    { id: 'wh-2', name: 'South' },
  ]);
});

describe('ScopedWarehouseNotice', () => {
  it.each(ROLES)('$label renders what the access-first version rendered', async (role) => {
    setUp(role);
    const before = await previousNotice();
    setUp(role);
    const after = await renderedText();
    expect(after).toBe(before);
  });

  it.each(ROLES.filter((r) => ['owner', 'admin', 'manager'].includes(r.role)))(
    '$label: null without any warehouse read',
    async (role) => {
      setUp(role);
      await expect(ScopedWarehouseNotice({})).resolves.toBeNull();
      expect(getWarehousesForRequest).not.toHaveBeenCalled();
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it('a scoped staff member still gets the notice naming their warehouse', async () => {
    setUp(ROLES[3]!);
    const text = await renderedText();
    expect(text).toContain('North');
    expect(stub.fromCalls).toEqual(
      expect.arrayContaining(['user_warehouse_assignments', 'organization_members']),
    );
  });
});
