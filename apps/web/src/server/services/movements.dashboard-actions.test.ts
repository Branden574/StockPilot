import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

// getDashboardActions feeds the Shift Command badges ("purchase orders",
// "cycle counts"). purchase_orders has no warehouse_id column: a PO belongs to
// a warehouse through its destination location (0322's comment). Filtering the
// PO count on warehouse_id made PostgREST answer 400 / 42703 whenever the
// topbar's warehouse filter was set, and the count read as 0 (seen in
// production on 2026-10-05 16:03Z for Learn4Life).

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
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

vi.mock('@/lib/dashboard/request-cache', () => ({
  getWarehousesForRequest: vi.fn(async () => []),
}));

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(async () => undefined),
}));

import { reportError } from '@/lib/error-reporter';
import { getDashboardActions } from './movements';

/** Columns each table really has, for the filters this function uses. */
const COLUMNS: Record<string, string[]> = {
  purchase_orders: ['id', 'organization_id', 'status', 'destination_location_id'],
  cycle_counts: ['id', 'organization_id', 'status', 'warehouse_id'],
};

/** Answer like PostgREST: a filter on a column the table does not have is a
 *  400 with 42703, and a dotted filter needs its embed in the select. */
function answer(table: string, count: number) {
  return (call: MockCall) => {
    const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
    for (let i = 0; i < call.methods.length; i++) {
      if (call.methods[i] !== 'eq' && call.methods[i] !== 'in') continue;
      const column = String(call.args[i]?.[0]);
      if (column.includes('.')) {
        const embed = column.split('.')[0];
        if (!select.includes(`${embed}:`)) {
          return { data: null, error: { message: `missing embed ${embed}`, code: 'PGRST100' } };
        }
        continue;
      }
      if (!COLUMNS[table]?.includes(column)) {
        return {
          data: null,
          error: { message: `column ${table}.${column} does not exist`, code: '42703' },
        };
      }
    }
    return { data: null, error: null, count };
  };
}

function stubWith(poCount: number, ccCount: number) {
  return makeSupabaseStub({
    'purchase_orders.select': answer('purchase_orders', poCount),
    'cycle_counts.select': answer('cycle_counts', ccCount),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDashboardActions', () => {
  it('counts open POs for the picked warehouse through the destination location', async () => {
    const stub = stubWith(4, 2);
    const actions = await getDashboardActions({
      warehouseId: 'wh-a',
      ctx: makeServiceContext(stub.client),
    });

    expect(actions.openPoCount).toBe(4);
    expect(actions.openCycleCount).toBe(2);

    const methods = stub.chains.get('purchase_orders.select') ?? [];
    const args = stub.chainArgs.get('purchase_orders.select') ?? [];
    expect(String(args[methods.indexOf('select')]?.[0])).toContain(
      'destination:locations!destination_location_id!inner (warehouse_id)',
    );
    const eqColumns = methods.flatMap((m, i) => (m === 'eq' ? [String(args[i]?.[0])] : []));
    expect(eqColumns).toContain('destination.warehouse_id');
    expect(eqColumns).not.toContain('warehouse_id');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('counts every open PO with no embed when no warehouse is picked', async () => {
    const stub = stubWith(7, 1);
    const actions = await getDashboardActions({ ctx: makeServiceContext(stub.client) });

    expect(actions.openPoCount).toBe(7);
    expect(actions.openCycleCount).toBe(1);
    const methods = stub.chains.get('purchase_orders.select') ?? [];
    const args = stub.chainArgs.get('purchase_orders.select') ?? [];
    expect(String(args[methods.indexOf('select')]?.[0])).toBe('id');
  });

  it('reports a failed count instead of passing it off as zero without a trace', async () => {
    const stub = makeSupabaseStub({
      'purchase_orders.select': {
        data: null,
        error: { message: 'boom', code: '57014' },
      },
      'cycle_counts.select': answer('cycle_counts', 3),
    });
    const actions = await getDashboardActions({ ctx: makeServiceContext(stub.client) });

    expect(actions.openPoCount).toBe(0);
    expect(actions.openCycleCount).toBe(3);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]?.[1]).toMatchObject({
      tag: 'dashboard-actions',
      level: 'warning',
      extra: { query: 'open_purchase_orders' },
    });
  });
});
