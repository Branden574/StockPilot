import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Services call the warehouse helpers directly. Default mock = full access;
// individual tests override per-call.
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

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { CycleCountsService } from './cycle-counts';
import { ServiceError } from './context';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWarehouseAccess).mockResolvedValue({
    readableIds: ['wh-a', 'wh-b'],
    writableIds: ['wh-a', 'wh-b'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  });
});

describe('CycleCountsService.start (selection scope)', () => {
  it('snapshots only the selected active items via the atomic start RPC', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', warehouse_id: 'wh-a' },
          { id: 'i2', warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 2 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const result = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1', 'i2'],
    });

    expect(result).toEqual({ id: 'cc-1', lineCount: 2, skipped: 0 });

    // Header + lines are inserted ATOMICALLY inside the RPC (no separate
    // cycle_counts / cycle_count_lines writes that could orphan a header).
    expect(stub.fromCalls).not.toContain('cycle_counts');
    expect(stub.fromCalls).not.toContain('cycle_count_lines');

    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect(rpc?.args).toMatchObject({
      p_organization_id: 'org-test',
      p_scope: 'selection',
      // All picks share wh-a, so the count is labeled with that warehouse.
      p_header_warehouse_id: 'wh-a',
      // Selection scope: no warehouse item filter; the validated ids drive it.
      p_filter_warehouse_id: null,
      p_item_ids: ['i1', 'i2'],
    });
  });

  it('reports skipped items when some picks are no longer active', async () => {
    const stub = makeSupabaseStub({
      // Only one of the two requested ids comes back active.
      'inventory_items.select': {
        data: [{ id: 'i1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 1 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const result = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1', 'i2-archived'],
    });

    // requested = 2 de-duped picks, RPC snapshotted 1 → 1 skipped.
    expect(result).toEqual({ id: 'cc-1', lineCount: 1, skipped: 1 });
    // The RPC re-selects exactly the validated active pick.
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect(rpc?.args).toMatchObject({ p_item_ids: ['i1'] });
  });

  it('throws validation_error when no selected item is still active', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await expect(
      svc.start({ scope: 'selection', warehouseId: null, itemIds: ['gone'] }),
    ).rejects.toBeInstanceOf(ServiceError);
    // Rejected BEFORE the snapshot RPC — no orphan header risk.
    expect(stub.rpcCalls.find((c) => c.name === 'start_cycle_count')).toBeUndefined();
  });

  it('asserts WRITE access to every distinct warehouse in the selection', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', warehouse_id: 'wh-a' },
          { id: 'i2', warehouse_id: 'wh-b' },
          { id: 'i3', warehouse_id: 'wh-a' },
        ],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 3 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await svc.start({ scope: 'selection', warehouseId: null, itemIds: ['i1', 'i2', 'i3'] });

    const whCalls = vi.mocked(assertWarehouseAccess).mock.calls.map((c) => [c[0], c[1]]);
    expect(whCalls).toEqual(expect.arrayContaining([['wh-a', 'write'], ['wh-b', 'write']]));
    // Distinct only — wh-a appears once despite two items.
    expect(whCalls.filter((c) => c[0] === 'wh-a')).toHaveLength(1);
    // Spans two warehouses, so the header warehouse stays null.
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect(rpc?.args).toMatchObject({ p_header_warehouse_id: null });
  });

  it('delegates to assign() when assignedTo is provided (fires notify trigger)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 1 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));
    const assignSpy = vi
      .spyOn(svc, 'assign')
      .mockResolvedValue({ id: 'cc-1', assigned_to: 'user-9' } as never);

    await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1'],
      assignedTo: 'user-9',
    });

    expect(assignSpy).toHaveBeenCalledWith('cc-1', 'user-9');
  });
});

describe('CycleCountsService.start (warehouse scope)', () => {
  it('snapshots via the atomic RPC with the warehouse item filter (no per-row insert)', async () => {
    const stub = makeSupabaseStub({
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-9', line_count: 12345 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const result = await svc.start({ scope: 'warehouse', warehouseId: 'wh-a' });

    // Warehouse scope never "skips" — the snapshot IS the scope.
    expect(result).toEqual({ id: 'cc-9', lineCount: 12345, skipped: 0 });
    // No item PRE-FETCH and no per-row line insert — the RPC does INSERT…SELECT.
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(stub.fromCalls).not.toContain('cycle_count_lines');
    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect(rpc?.args).toMatchObject({
      p_organization_id: 'org-test',
      p_scope: 'warehouse',
      p_header_warehouse_id: 'wh-a',
      p_filter_warehouse_id: 'wh-a',
      p_item_ids: null,
    });
    // Gated the warehouse for WRITE before snapshotting.
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith('wh-a', 'write', expect.anything());
  });

  it('maps the RPC empty-scope raise to a validation_error (no orphan header)', async () => {
    // The RPC raises cycle_count_no_items when the scope has zero active
    // items; the whole function (incl. the header insert) rolls back, so the
    // service just surfaces the friendly validation error.
    const stub = makeSupabaseStub({
      'rpc:start_cycle_count': {
        data: null,
        error: { message: 'cycle_count_no_items' },
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await expect(
      svc.start({ scope: 'warehouse', warehouseId: 'wh-a' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // Only the RPC was ever called — there is no separate header insert that
    // could be left orphaned.
    expect(stub.fromCalls).not.toContain('cycle_counts');
  });

  it('org-wide count (warehouseId null) passes a null filter + null header warehouse', async () => {
    const stub = makeSupabaseStub({
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-org', line_count: 5 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    await svc.start({ scope: 'warehouse', warehouseId: null });

    const rpc = stub.rpcCalls.find((c) => c.name === 'start_cycle_count');
    expect(rpc?.args).toMatchObject({
      p_scope: 'warehouse',
      p_header_warehouse_id: null,
      p_filter_warehouse_id: null,
      p_item_ids: null,
    });
  });
});

describe('CycleCountsService — manager-level permission floor for start/cancel', () => {
  // cycle_counts INSERT/UPDATE RLS requires manager. A staff role holds
  // stock:adjust but NOT cycle_counts:assign, so start()/cancel() must reject
  // with a clean `forbidden` BEFORE any DB round-trip (previously staff got an
  // opaque internal_error 500 on start, or a misleading conflict on cancel).
  it('start() throws forbidden for a staff-role context', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 1 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff' }));

    await expect(
      svc.start({ scope: 'selection', warehouseId: null, itemIds: ['i1'] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Rejected before touching the DB.
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(stub.rpcCalls.find((c) => c.name === 'start_cycle_count')).toBeUndefined();
  });

  it('cancel() throws forbidden for a staff-role context', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.update': { data: [{ id: 'cc-1' }], error: null },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'staff' }));

    await expect(svc.cancel('cc-1')).rejects.toMatchObject({ code: 'forbidden' });
    // Rejected before touching the DB.
    expect(stub.fromCalls).not.toContain('cycle_counts');
  });

  it('start() does NOT reject for a manager-role context (permission floor met)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [{ id: 'i1', warehouse_id: 'wh-a' }],
        error: null,
      },
      'rpc:start_cycle_count': {
        data: [{ cycle_count_id: 'cc-1', line_count: 1 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client, { role: 'manager' }));

    const result = await svc.start({
      scope: 'selection',
      warehouseId: null,
      itemIds: ['i1'],
    });
    expect(result.id).toBe('cc-1');
  });
});

describe('CycleCountsService.itemsInScopeCount', () => {
  it('returns 0 for a selection-scoped count (no "new items" concept)', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [{ warehouse_id: null, status: 'in_progress', scope: 'selection' }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const n = await svc.itemsInScopeCount('cc-1');
    expect(n).toBe(0);
    // It must not even query inventory_items for a selection count.
    expect(stub.fromCalls).not.toContain('inventory_items');
  });
});
