import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

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

// withContext is used by the standalone (non-class) helpers in movements.ts.
// Mock it so we can inject a stub supabase client and assert against the
// recorded calls without standing up a real DB.
const mockedCtx: { value: unknown } = { value: null };
vi.mock('./context', async () => {
  const actual =
    await vi.importActual<typeof import('./context')>('./context');
  return {
    ...actual,
    withContext: vi.fn(async () => mockedCtx.value),
  };
});

import { getWarehouseAccess } from '@/lib/auth/warehouse';
import {
  MovementsService,
  getDashboardSummary,
  getThirtyDayMetrics,
} from './movements';
import { ServiceError } from './context';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
});

describe('MovementsService.list', () => {
  it('does not apply warehouse filter when user has all-access and no warehouseId param', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.list();

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    // No warehouse-scoping eq/in should appear when scope isn't needed.
    const eqArgs = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq')
      .map((c) => c.args![0] as string);
    expect(eqArgs).not.toContain('item.warehouse_id');
    expect(chain).not.toContain('in');
  });

  it('scopes by item.warehouse_id when warehouseId param is set', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.list({ warehouseId: 'wh-x' });

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    const eqCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('item.warehouse_id')).toBe('wh-x');
  });

  it('returns [] when warehouse-scoped user has no readable warehouses', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [{ id: 'leak' }], error: null },
    });
    const svc = new MovementsService(
      makeServiceContext(stub.client, { role: 'staff' }),
    );

    const result = await svc.list();
    expect(result).toEqual([]);
  });

  it('flattens item + actor when PostgREST returns them as arrays', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'adjust',
            item: [{ id: 'i1', name: 'Widget', sku: 'W1' }],
            actor: [{ id: 'u1', full_name: 'Alice', email: 'a@x.com' }],
          },
        ],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    expect(rows[0]!.item).toEqual({ id: 'i1', name: 'Widget', sku: 'W1' });
    expect(rows[0]!.actor).toEqual({
      id: 'u1',
      fullName: 'Alice',
      email: 'a@x.com',
    });
  });

  it('passes through item + actor when PostgREST returns them as objects', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm2',
            movement_type: 'transfer',
            item: { id: 'i2', name: 'Gadget', sku: 'G1' },
            actor: { id: 'u2', full_name: null, email: 'b@x.com' },
          },
        ],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    expect(rows[0]!.item).toEqual({ id: 'i2', name: 'Gadget', sku: 'G1' });
    expect(rows[0]!.actor).toEqual({
      id: 'u2',
      fullName: null,
      email: 'b@x.com',
    });
  });

  it('returns null actor when row has no profile match', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm3',
            movement_type: 'initial',
            item: null,
            actor: null,
          },
        ],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    expect(rows[0]!.actor).toBeNull();
    expect(rows[0]!.item).toBeNull();
  });
});

describe('getDashboardSummary', () => {
  it('uses the get_dashboard_summary RPC when no warehouseId is set', async () => {
    const stub = makeSupabaseStub({
      'rpc:get_dashboard_summary': {
        data: [
          {
            item_count: 12,
            out_of_stock_count: 1,
            low_stock_count: 2,
            inventory_value: 1234.5,
          },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const result = await getDashboardSummary();

    expect(stub.rpcCalls).toEqual([
      { name: 'get_dashboard_summary', args: { p_org_id: 'org-test' } },
    ]);
    expect(result).toEqual({
      itemCount: 12,
      outOfStockCount: 1,
      lowStockCount: 2,
      inventoryValue: 1234.5,
    });
  });

  it('falls back to direct aggregate when warehouseId is provided', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          // active, normal stock
          { quantity_on_hand: 10, reorder_point: 0, unit_cost: 2, status: 'active' },
          // active, out-of-stock
          { quantity_on_hand: 0, reorder_point: 5, unit_cost: 4, status: 'active' },
          // active, low-stock (qty <= reorder_point and reorder > 0)
          { quantity_on_hand: 3, reorder_point: 5, unit_cost: 1, status: 'active' },
          // archived rows are excluded entirely
          { quantity_on_hand: 9999, reorder_point: 0, unit_cost: 1, status: 'archived' },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const result = await getDashboardSummary({ warehouseId: 'wh-a' });

    // RPC should NOT have fired in the warehouse-scoped path.
    expect(stub.rpcCalls).toHaveLength(0);
    expect(result.itemCount).toBe(3);
    expect(result.outOfStockCount).toBe(1);
    expect(result.lowStockCount).toBe(1);
    // 10*2 + 0*4 + 3*1 = 23
    expect(result.inventoryValue).toBe(23);
  });

  it('throws ServiceError when the RPC errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:get_dashboard_summary': { data: null, error: { message: 'rpc failed' } },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    await expect(getDashboardSummary()).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('getThirtyDayMetrics', () => {
  it('buckets per-day counts and aggregates byType sorted desc with share', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          { movement_type: 'adjust', created_at: new Date(now - 2 * dayMs).toISOString() },
          { movement_type: 'adjust', created_at: new Date(now - 2 * dayMs).toISOString() },
          { movement_type: 'transfer', created_at: new Date(now - 5 * dayMs).toISOString() },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const metrics = await getThirtyDayMetrics();
    expect(metrics.dailyCounts).toHaveLength(30);
    // Total events distributed across the 30-day window equals 3.
    const total = metrics.dailyCounts.reduce((s, n) => s + n, 0);
    expect(total).toBe(3);

    expect(metrics.byType[0]).toEqual({ type: 'adjust', count: 2, share: 1 });
    expect(metrics.byType[1]).toEqual({ type: 'transfer', count: 1, share: 0.5 });
  });

  it('returns empty buckets and empty byType when no rows exist', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const metrics = await getThirtyDayMetrics();
    expect(metrics.byType).toEqual([]);
    expect(metrics.dailyCounts.every((n) => n === 0)).toBe(true);
    expect(metrics.dailyCounts).toHaveLength(30);
  });

  it('adds item.warehouse_id eq filter when warehouseId is set', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    await getThirtyDayMetrics({ warehouseId: 'wh-x' });

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    const eqCalls = chain
      .map((m, i) => ({ m, args: args[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('item.warehouse_id')).toBe('wh-x');
  });
});
