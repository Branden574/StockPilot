// list() warehouse scoping for a WAREHOUSE-SCOPED user (staff/viewer with
// assignments). Regression pin for SP-127: `.in('warehouse_id', ids)` compiles
// to `= ANY(...)` which is NULL for a NULL column, so a count whose header
// warehouse is null (a manager's selection spanning two warehouses, or an
// org-wide count) was DROPPED from the list of the very staffer it was
// assigned to — while the mobile list (org-member RLS, no warehouse filter)
// showed it. See recurring bug pattern #23(b).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { CycleCountsService } from './cycle-counts';

beforeEach(() => {
  vi.clearAllMocks();
});

function scopedAccess() {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: false,
    primaryWarehouseId: 'wh-a',
  });
}

function fullAccess() {
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
}

/** Flatten the recorded chain into [method, args] pairs for assertions. */
function callsFor(
  chains: Map<string, string[]>,
  chainArgs: Map<string, unknown[][]>,
  key: string,
): Array<[string, unknown[]]> {
  const names = chains.get(key) ?? [];
  const args = chainArgs.get(key) ?? [];
  return names.map((n, i) => [n, args[i] ?? []]);
}

describe('CycleCountsService.list — warehouse-scoped visibility', () => {
  it('a warehouse-scoped staffer still sees null-warehouse counts ASSIGNED TO HER', async () => {
    scopedAccess();
    const stub = makeSupabaseStub({ 'cycle_counts.select': { data: [], error: null } });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'staff', userId: 'u-dana' }),
    );

    await svc.list();

    const calls = callsFor(stub.chains, stub.chainArgs, 'cycle_counts.select');
    // The bare `.in('warehouse_id', …)` is what dropped the row (NULL is never
    // a member of an ANY(...) list).
    expect(calls.find(([m, a]) => m === 'in' && a[0] === 'warehouse_id')).toBeUndefined();
    const or = calls.find(([m]) => m === 'or');
    expect(or?.[1][0]).toBe(
      'warehouse_id.in.(wh-a,wh-b),and(warehouse_id.is.null,assigned_to.eq.u-dana)',
    );
  });

  it('a full-access manager is unfiltered (no .in and no .or narrowing)', async () => {
    fullAccess();
    const stub = makeSupabaseStub({ 'cycle_counts.select': { data: [], error: null } });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'manager', userId: 'u-mgr' }),
    );

    await svc.list();

    const calls = callsFor(stub.chains, stub.chainArgs, 'cycle_counts.select');
    expect(calls.find(([m, a]) => m === 'in' && a[0] === 'warehouse_id')).toBeUndefined();
    expect(calls.find(([m]) => m === 'or')).toBeUndefined();
  });

  it('a user with no writable warehouses gets [] without querying', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValue({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const stub = makeSupabaseStub({ 'cycle_counts.select': { data: [{ id: 'cc-1' }], error: null } });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { role: 'viewer', userId: 'u-nobody' }),
    );

    await expect(svc.list()).resolves.toEqual([]);
  });
});
