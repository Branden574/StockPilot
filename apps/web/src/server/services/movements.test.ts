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
  getDashboardHistory,
  getDashboardSummary,
  getDashboardValueComparison,
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

  // ── Issues 3 + 4 (mig 0231): moved_quantity passthrough + receipt_line map ──

  it('passes moved_quantity through for transfer rows (and null on old rows)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'tx-new',
            movement_type: 'transfer',
            quantity_change: 0,
            moved_quantity: 250,
            reason: null,
            notes: null,
            item: null,
            actor: null,
          },
          {
            id: 'tx-old',
            movement_type: 'transfer',
            quantity_change: 0,
            moved_quantity: null,
            reason: null,
            notes: null,
            item: null,
            actor: null,
          },
        ],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    expect(rows[0]!.moved_quantity).toBe(250);
    expect(rows[1]!.moved_quantity).toBeNull();
    // No receipt_line rows → the receipts resolver query never fires.
    expect(stub.fromCalls).not.toContain('receipts');
  });

  it("maps OLD receipt rows' reason 'receipt_line' to 'PO {number}' via one batched receipts query", async () => {
    const receiptId = '11111111-2222-3333-4444-555555555555';
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'r-old',
            movement_type: 'receive_po',
            quantity_change: 5,
            moved_quantity: null,
            reason: 'receipt_line',
            notes: receiptId,
            item: null,
            actor: null,
          },
          {
            id: 'r-new',
            movement_type: 'receive_po',
            quantity_change: 3,
            moved_quantity: null,
            reason: 'PO PO-88',
            notes: receiptId,
            item: null,
            actor: null,
          },
        ],
        error: null,
      },
      'receipts.select': {
        data: [{ id: receiptId, purchase_orders: { po_number: 'PO-2026-014' } }],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    // Old row: display reason resolved from the receipt id in notes.
    expect(rows[0]!.reason).toBe('PO PO-2026-014');
    // notes keeps the raw receipt id — consumers (stagedWorklist) rely on it.
    expect(rows[0]!.notes).toBe(receiptId);
    // New row (0231+) passes through untouched.
    expect(rows[1]!.reason).toBe('PO PO-88');
    // Exactly one extra batched query.
    expect(stub.fromCalls.filter((t) => t === 'receipts')).toHaveLength(1);
  });

  it("falls back to 'PO receipt' when the old row's receipt id cannot be resolved", async () => {
    const receiptId = '11111111-2222-3333-4444-555555555555';
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'r-orphan',
            movement_type: 'receive_po',
            quantity_change: 5,
            moved_quantity: null,
            reason: 'receipt_line',
            notes: receiptId,
            item: null,
            actor: null,
          },
        ],
        error: null,
      },
      'receipts.select': { data: [], error: null },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const rows = await svc.list();
    expect(rows[0]!.reason).toBe('PO receipt');
  });

  // ── P3 Task 2: movement_type + date-range filters (Movements page) ──

  it('applies since/until/types filters onto the query', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.list({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-02-01T00:00:00.000Z',
      types: ['adjust', 'transfer'],
    });

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    const calls = chain.map((m, i) => ({ m, args: args[i] }));
    expect(calls).toContainEqual({ m: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'lt', args: ['created_at', '2026-02-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'in', args: ['movement_type', ['adjust', 'transfer']] });
  });

  it('omits since/until/types filters when unset', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.list();

    const chain = stub.chains.get('stock_movements.select') ?? [];
    expect(chain).not.toContain('gte');
    expect(chain).not.toContain('lt');
    // 'in' is also used for warehouse scoping, but this ctx has all-access
    // and no warehouseId, so no 'in' call of any kind should appear.
    expect(chain).not.toContain('in');
  });
});

describe('MovementsService.count — type/date filters', () => {
  it('applies since/until/types filters onto the query', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: null, error: null, count: 0 },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.count({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-02-01T00:00:00.000Z',
      types: ['damage'],
    });

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    const calls = chain.map((m, i) => ({ m, args: args[i] }));
    expect(calls).toContainEqual({ m: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'lt', args: ['created_at', '2026-02-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'in', args: ['movement_type', ['damage']] });
  });
});

describe('MovementsService.exportRows', () => {
  it('maps a row with resolved from/to location names, reference fields, and actor email', async () => {
    const fromLocId = '11111111-1111-1111-1111-111111111111';
    const toLocId = '22222222-2222-2222-2222-222222222222';
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm1',
            movement_type: 'transfer',
            quantity_change: 0,
            previous_quantity: 10,
            new_quantity: 10,
            from_location_id: fromLocId,
            to_location_id: toLocId,
            reference_type: 'order_request',
            reference_id: 'ref-1',
            reason: null,
            notes: null,
            created_at: '2026-05-01T00:00:00.000Z',
            item_id: 'item-1',
            user_id: 'user-1',
            item: { id: 'item-1', name: 'Widget', sku: 'W1' },
            actor: { id: 'user-1', full_name: 'Alice', email: 'alice@x.com' },
          },
        ],
        error: null,
        count: 1,
      },
      'locations.select': {
        data: [
          { id: fromLocId, name: 'Rack A' },
          { id: toLocId, name: 'Rack B' },
        ],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const { rows, total } = await svc.exportRows();
    expect(total).toBe(1);
    expect(rows).toEqual([
      {
        id: 'm1',
        createdAt: '2026-05-01T00:00:00.000Z',
        itemSku: 'W1',
        itemName: 'Widget',
        movementType: 'transfer',
        quantityChange: 0,
        previousQuantity: 10,
        newQuantity: 10,
        fromLocation: 'Rack A',
        toLocation: 'Rack B',
        referenceType: 'order_request',
        referenceId: 'ref-1',
        reason: null,
        notes: null,
        actorEmail: 'alice@x.com',
      },
    ]);
  });

  it('flattens item + actor arrays and skips the locations query when no location ids are present', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm3',
            movement_type: 'adjust',
            quantity_change: -2,
            previous_quantity: 5,
            new_quantity: 3,
            from_location_id: null,
            to_location_id: null,
            reference_type: null,
            reference_id: null,
            reason: 'Shrinkage',
            notes: null,
            created_at: '2026-05-03T00:00:00.000Z',
            item_id: 'item-3',
            user_id: 'user-3',
            item: [{ id: 'item-3', name: 'Gadget', sku: 'G1' }],
            actor: [{ id: 'user-3', full_name: null, email: 'c@x.com' }],
          },
        ],
        error: null,
        count: 1,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const { rows } = await svc.exportRows();
    expect(rows[0]!.itemSku).toBe('G1');
    expect(rows[0]!.itemName).toBe('Gadget');
    expect(rows[0]!.actorEmail).toBe('c@x.com');
    expect(rows[0]!.fromLocation).toBeNull();
    expect(rows[0]!.toLocation).toBeNull();
    expect(stub.fromCalls).not.toContain('locations');
  });

  it("resolves a legacy 'receipt_line' reason to 'PO {number}' via the same batched receipts lookup as list()", async () => {
    const receiptId = '33333333-3333-3333-3333-333333333333';
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [
          {
            id: 'm2',
            movement_type: 'receive_po',
            quantity_change: 5,
            previous_quantity: 0,
            new_quantity: 5,
            from_location_id: null,
            to_location_id: null,
            reference_type: null,
            reference_id: null,
            reason: 'receipt_line',
            notes: receiptId,
            created_at: '2026-05-02T00:00:00.000Z',
            item_id: 'item-2',
            user_id: null,
            item: null,
            actor: null,
          },
        ],
        error: null,
        count: 1,
      },
      'receipts.select': {
        data: [{ id: receiptId, purchase_orders: { po_number: 'PO-77' } }],
        error: null,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const { rows } = await svc.exportRows();
    expect(rows[0]!.reason).toBe('PO PO-77');
  });

  it('returns rows: [] total: 0 when a warehouse-scoped user has no readable warehouses (no leak)', async () => {
    vi.mocked(getWarehouseAccess).mockResolvedValueOnce({
      readableIds: [],
      writableIds: [],
      hasAllAccess: false,
      primaryWarehouseId: null,
    });
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [{ id: 'leak' }], error: null, count: 1 },
    });
    const svc = new MovementsService(
      makeServiceContext(stub.client, { role: 'staff' }),
    );

    const result = await svc.exportRows();
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('applies since/until/types/search filters onto the query', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': { data: [], error: null, count: 0 },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    await svc.exportRows({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-02-01T00:00:00.000Z',
      types: ['adjust'],
      search: 'wid',
    });

    const chain = stub.chains.get('stock_movements.select') ?? [];
    const args = stub.chainArgs.get('stock_movements.select') ?? [];
    const calls = chain.map((m, i) => ({ m, args: args[i] }));
    expect(calls).toContainEqual({ m: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'lt', args: ['created_at', '2026-02-01T00:00:00.000Z'] });
    expect(calls).toContainEqual({ m: 'in', args: ['movement_type', ['adjust']] });
  });

  it('reports the true total even when cap clips the returned rows (truncation sentinel)', async () => {
    const stub = makeSupabaseStub({
      'stock_movements.select': {
        data: [{ id: 'm1', item: null, actor: null }],
        error: null,
        count: 9_999,
      },
    });
    const svc = new MovementsService(makeServiceContext(stub.client));

    const { rows, total } = await svc.exportRows({ cap: 1 });
    expect(total).toBe(9_999);
    expect(rows).toHaveLength(1);
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
  // Post-0224: getThirtyDayMetrics calls the dashboard_movement_metrics RPC
  // (per day-bucket + movement_type counts) and rolls the rows up in JS. These
  // tests drive that mapping via a stubbed RPC. The bucket-vs-individual-count
  // equivalence to the pre-0224 JS path is proven in dashboard-metrics-parity.
  // Since 0230 the RPC serves closed days from snapshot rollups (observed UTC
  // days) and counts only today live — same call signature, same row shape,
  // so the wiring asserted here is unchanged.
  it('rolls RPC (day,type) counts into dailyCounts + byType sorted desc with share', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_movement_metrics': {
        data: [
          { day_index: 5, movement_type: 'adjust', move_count: 2 },
          { day_index: 2, movement_type: 'transfer', move_count: 1 },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const metrics = await getThirtyDayMetrics();

    expect(stub.rpcCalls).toEqual([
      {
        name: 'dashboard_movement_metrics',
        args: { p_organization_id: 'org-test', p_warehouse_id: null, p_days: 30 },
      },
    ]);
    expect(metrics.dailyCounts).toHaveLength(30);
    // Total events distributed across the 30-day window equals 3.
    const total = metrics.dailyCounts.reduce((s, n) => s + n, 0);
    expect(total).toBe(3);
    expect(metrics.dailyCounts[5]).toBe(2);
    expect(metrics.dailyCounts[2]).toBe(1);

    expect(metrics.byType[0]).toEqual({ type: 'adjust', count: 2, share: 1 });
    expect(metrics.byType[1]).toEqual({ type: 'transfer', count: 1, share: 0.5 });
  });

  it('coerces bigint move_count strings and sums same-type rows across days', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_movement_metrics': {
        data: [
          { day_index: 1, movement_type: 'adjust', move_count: '3' },
          { day_index: 9, movement_type: 'adjust', move_count: '4' },
          { day_index: 9, movement_type: 'receive_po', move_count: '4' },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const metrics = await getThirtyDayMetrics();
    // adjust = 3 + 4 = 7 across two days; receive_po = 4.
    expect(metrics.byType[0]).toEqual({ type: 'adjust', count: 7, share: 1 });
    expect(metrics.byType[1]).toEqual({ type: 'receive_po', count: 4, share: 4 / 7 });
    expect(metrics.dailyCounts.reduce((s, n) => s + n, 0)).toBe(11);
  });

  it('returns empty buckets and empty byType when the RPC returns no rows', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_movement_metrics': { data: [], error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const metrics = await getThirtyDayMetrics();
    expect(metrics.byType).toEqual([]);
    expect(metrics.dailyCounts.every((n) => n === 0)).toBe(true);
    expect(metrics.dailyCounts).toHaveLength(30);
  });

  it('passes p_warehouse_id when warehouseId is set', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_movement_metrics': { data: [], error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    await getThirtyDayMetrics({ warehouseId: 'wh-x' });

    expect(stub.rpcCalls).toEqual([
      {
        name: 'dashboard_movement_metrics',
        args: { p_organization_id: 'org-test', p_warehouse_id: 'wh-x', p_days: 30 },
      },
    ]);
  });

  it('throws ServiceError when the RPC errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_movement_metrics': { data: null, error: { message: 'boom' } },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    await expect(getThirtyDayMetrics()).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('getDashboardHistory', () => {
  // Post-0224: getDashboardHistory calls the dashboard_history_series RPC (one
  // row per day: item_count, inventory_value, low_out_count) and maps rows into
  // the three oldest→newest series arrays. Parity with the old reverse-walk is
  // proven in dashboard-history-parity; these tests cover the wiring + mapping.
  // Since 0230 the RPC serves closed days from snapshot rollups (observed UTC
  // day closes) and computes only today live — same call signature, same
  // one-row-per-day_index shape, so the wiring asserted here is unchanged.
  it('maps RPC rows into the three series and calls with default 30-day window', async () => {
    const rows = [
      { day_index: 0, item_count: 4, inventory_value: 100, low_out_count: 1 },
      { day_index: 1, item_count: 5, inventory_value: 150.25, low_out_count: 0 },
      { day_index: 2, item_count: 6, inventory_value: 200, low_out_count: 2 },
    ];
    // Real windows are 30/90 rows; three rows keep the assertion readable.
    const stub = makeSupabaseStub({
      'rpc:dashboard_history_series': { data: rows, error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const history = await getDashboardHistory();

    expect(stub.rpcCalls).toEqual([
      {
        name: 'dashboard_history_series',
        args: { p_organization_id: 'org-test', p_warehouse_id: null, p_days: 30 },
      },
    ]);
    expect(history.rangeDays).toBe(30);
    expect(history.itemCountSeries).toHaveLength(30);
    expect(history.itemCountSeries.slice(0, 3)).toEqual([4, 5, 6]);
    expect(history.inventoryValueSeries.slice(0, 3)).toEqual([100, 150.25, 200]);
    expect(history.lowOutSeries.slice(0, 3)).toEqual([1, 0, 2]);
  });

  it('coerces numeric-string inventory_value and tolerates out-of-order rows', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_history_series': {
        data: [
          { day_index: 2, item_count: 6, inventory_value: '200.0000', low_out_count: 2 },
          { day_index: 0, item_count: 4, inventory_value: '100.5000', low_out_count: 1 },
        ],
        error: null,
      },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const history = await getDashboardHistory();
    expect(history.inventoryValueSeries[0]).toBe(100.5);
    expect(history.inventoryValueSeries[2]).toBe(200);
  });

  it('passes rangeDays as p_days and p_warehouse_id through', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_history_series': { data: [], error: null },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    const history = await getDashboardHistory({ warehouseId: 'wh-x', rangeDays: 90 });

    expect(stub.rpcCalls).toEqual([
      {
        name: 'dashboard_history_series',
        args: { p_organization_id: 'org-test', p_warehouse_id: 'wh-x', p_days: 90 },
      },
    ]);
    expect(history.rangeDays).toBe(90);
    expect(history.itemCountSeries).toHaveLength(90);
  });

  it('throws ServiceError when the RPC errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_history_series': { data: null, error: { message: 'boom' } },
    });
    mockedCtx.value = makeServiceContext(stub.client);

    await expect(getDashboardHistory()).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('getDashboardValueComparison', () => {
  // On-demand comparison series behind the value card's Compare menu. Every
  // mode reads the dashboard_value_series RPC (migration 0275) via ctx.supabase.
  it("'previous' fetches a days*2 window and splits it older/newer", async () => {
    // day_index 0 = oldest. 10 lands in the previous half (index 0), 20 at the
    // start of the current half (index 30), 99 at the newest edge (index 59).
    const stub = makeSupabaseStub({
      'rpc:dashboard_value_series': {
        data: [
          { day_index: 0, value: 10 },
          { day_index: 30, value: 20 },
          { day_index: 59, value: '99.0000' },
        ],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client);

    const result = await getDashboardValueComparison({
      ctx,
      days: 30,
      basis: 'cost',
      mode: 'previous',
    });

    // One RPC call for the double window.
    expect(stub.rpcCalls).toEqual([
      {
        name: 'dashboard_value_series',
        args: {
          p_organization_id: 'org-test',
          p_warehouse_id: null,
          p_days: 60,
          p_basis: 'cost',
        },
      },
    ]);
    expect(result.mode).toBe('previous');
    expect(result.days).toBe(30);
    expect(result.series.map((s) => s.label)).toEqual([
      'Previous period',
      'Current period',
    ]);
    expect(result.series[0]?.data).toHaveLength(30);
    expect(result.series[1]?.data).toHaveLength(30);
    expect(result.series[0]?.data[0]).toBe(10);
    expect(result.series[1]?.data[0]).toBe(20);
    // numeric-string coercion at the newest edge of the current half.
    expect(result.series[1]?.data[29]).toBe(99);
  });

  it("'retail_vs_cost' fetches the same window on both bases", async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_value_series': {
        data: [{ day_index: 0, value: 5 }],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client);

    const result = await getDashboardValueComparison({
      ctx,
      warehouseId: 'wh-7',
      days: 30,
      basis: 'cost',
      mode: 'retail_vs_cost',
    });

    expect(result.series.map((s) => s.label)).toEqual(['Cost', 'Retail (approx.)']);
    expect(result.series[0]?.data).toHaveLength(30);
    expect(result.series[1]?.data).toHaveLength(30);
    // Two RPC calls, same window/warehouse, one per basis.
    expect(stub.rpcCalls).toHaveLength(2);
    expect(stub.rpcCalls[0]?.args).toMatchObject({ p_days: 30, p_warehouse_id: 'wh-7', p_basis: 'cost' });
    expect(stub.rpcCalls[1]?.args).toMatchObject({ p_days: 30, p_warehouse_id: 'wh-7', p_basis: 'retail' });
  });

  it("'locations' lists warehouses, caps at 6, one series per warehouse", async () => {
    const warehouses = Array.from({ length: 8 }, (_, i) => ({
      id: `wh-${i + 1}`,
      name: `WH${i + 1}`,
    }));
    const stub = makeSupabaseStub({
      'warehouses.select': { data: warehouses, error: null },
      // Unconfigured rpc → null data → a length-`days` all-zero array.
    });
    const ctx = makeServiceContext(stub.client);

    const result = await getDashboardValueComparison({
      ctx,
      days: 90,
      basis: 'retail',
      mode: 'locations',
    });

    // Capped at VALUE_COMPARISON_LOCATION_CAP (6).
    expect(result.series).toHaveLength(6);
    expect(result.series.map((s) => s.label)).toEqual([
      'WH1', 'WH2', 'WH3', 'WH4', 'WH5', 'WH6',
    ]);
    expect(result.series[0]?.data).toHaveLength(90);
    // One RPC per rendered warehouse, each scoped to that warehouse id.
    expect(stub.rpcCalls).toHaveLength(6);
    expect(stub.rpcCalls.map((c) => (c.args as { p_warehouse_id: string }).p_warehouse_id)).toEqual([
      'wh-1', 'wh-2', 'wh-3', 'wh-4', 'wh-5', 'wh-6',
    ]);
    expect(stub.rpcCalls.every((c) => (c.args as { p_basis: string }).p_basis === 'retail')).toBe(true);
  });

  it('throws ServiceError when the value RPC errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:dashboard_value_series': { data: null, error: { message: 'boom' } },
    });
    const ctx = makeServiceContext(stub.client);

    await expect(
      getDashboardValueComparison({ ctx, days: 30, basis: 'cost', mode: 'previous' }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
