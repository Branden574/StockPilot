/**
 * Tests for PurchaseOrdersService.listStats / listPage — the 0227 RPC-backed
 * replacements for the PO index's fetch-every-row JS aggregation (scale-audit
 * rank 8). Asserts:
 *   • the warehouse-scope → p_warehouse_ids mapping reproduces list()'s
 *     branch structure exactly (all-access / view-filter / restricted /
 *     zero-readable),
 *   • RPC args (statuses, trimmed q, limit/offset from page/perPage),
 *   • row/stat mapping incl. PostgREST numeric-string coercion,
 *   • the empty-deep-page probe that recovers the true filtered total,
 *   • errors surface as ServiceError (fail closed, page shows retry banner).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { getWarehouseAccessMock } = vi.hoisted(() => ({
  getWarehouseAccessMock: vi.fn(),
}));

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: getWarehouseAccessMock,
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-id') }));
vi.mock('./item-images', () => ({ ItemImagesService: class {} }));
vi.mock('./inventory', () => ({ InventoryService: class {} }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

const WH_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const WH_B = 'aaaaaaaa-0000-0000-0000-000000000002';

function allAccess() {
  getWarehouseAccessMock.mockResolvedValue({
    hasAllAccess: true,
    readableIds: [],
    writableIds: [],
    primaryWarehouseId: null,
  });
}

function restrictedTo(ids: string[]) {
  getWarehouseAccessMock.mockResolvedValue({
    hasAllAccess: false,
    readableIds: ids,
    writableIds: ids,
    primaryWarehouseId: ids[0] ?? null,
  });
}

const STATS_ROW = {
  total_count: '8',
  total_value: '2080',
  open_count: 4,
  committed_value: '750',
  open_supplier_count: 2,
  inbound_count: 3,
  next_eta_po_number: 'PO-1003',
  next_eta_expected_at: '2026-07-08T00:00:00Z',
  avg_lead_days: '7.25',
};

const PAGE_ROW = {
  id: 'po-1',
  po_number: 'PO-1002',
  status: 'ordered',
  supplier_id: 's1',
  destination_location_id: 'loc-1',
  expected_at: null,
  ordered_at: '2026-06-27T00:00:00Z',
  received_at: null,
  total: 200,
  created_at: '2026-06-27T00:00:00Z',
  updated_at: '2026-06-27T00:00:00Z',
  line_count: '2',
  filtered_count: '41',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PurchaseOrdersService.listStats', () => {
  it('all-access, no view-filter → p_warehouse_ids null (org-wide, left-join parity with list()); snake_case row maps to camelCase with numeric-string coercion', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_stats': { data: [STATS_ROW], error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const stats = await svc.listStats();

    expect(stub.rpcCalls).toEqual([
      {
        name: 'purchase_orders_stats',
        args: { p_organization_id: 'org-test', p_warehouse_ids: null },
      },
    ]);
    expect(stats).toEqual({
      totalCount: 8,
      totalValue: 2080,
      openCount: 4,
      committedValue: 750,
      openSupplierCount: 2,
      inboundCount: 3,
      nextEtaPoNumber: 'PO-1003',
      nextEtaExpectedAt: '2026-07-08T00:00:00Z',
      avgLeadDays: 7.25, // UNROUNDED — the page keeps its own Math.round
    });
  });

  it('all-access + active warehouse view-filter → that single warehouse id', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_stats': { data: [STATS_ROW], error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.listStats({ warehouseId: WH_A });

    expect(stub.rpcCalls[0]!.args).toEqual({
      p_organization_id: 'org-test',
      p_warehouse_ids: [WH_A],
    });
  });

  it('restricted user → their readableIds; the view-filter is IGNORED (exact list() parity)', async () => {
    restrictedTo([WH_A, WH_B]);
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_stats': { data: [STATS_ROW], error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await svc.listStats({ warehouseId: 'some-other-warehouse' });

    expect(stub.rpcCalls[0]!.args).toEqual({
      p_organization_id: 'org-test',
      p_warehouse_ids: [WH_A, WH_B],
    });
  });

  it('restricted user with ZERO readable warehouses → zero stats WITHOUT any query (list() returned [] the same way)', async () => {
    restrictedTo([]);
    const stub = makeSupabaseStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const stats = await svc.listStats();

    expect(stub.rpcCalls).toHaveLength(0);
    expect(stats).toEqual({
      totalCount: 0,
      totalValue: 0,
      openCount: 0,
      committedValue: 0,
      openSupplierCount: 0,
      inboundCount: 0,
      nextEtaPoNumber: null,
      nextEtaExpectedAt: null,
      avgLeadDays: null,
    });
  });

  it('null avg_lead_days (no received POs in 90d) maps to null, not 0', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_stats': {
        data: [{ ...STATS_ROW, avg_lead_days: null, next_eta_po_number: null, next_eta_expected_at: null }],
        error: null,
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const stats = await svc.listStats();

    expect(stats.avgLeadDays).toBeNull();
    expect(stats.nextEtaPoNumber).toBeNull();
    expect(stats.nextEtaExpectedAt).toBeNull();
  });

  it('RPC errors surface as ServiceError (page degrades to its retry banner)', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_stats': { data: null, error: { message: 'stats boom' } },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.listStats().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    // ServiceError sanitizes internal messages for clients — assert the code.
    expect((thrown as ServiceError).code).toBe('internal_error');
  });
});

describe('PurchaseOrdersService.listPage', () => {
  it('passes tab statuses + trimmed q + limit/offset; strips filtered_count from rows and reads it as the total (never clamped — SQL window count)', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_page': { data: [PAGE_ROW], error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.listPage({
      statuses: ['expected_inbound', 'partially_received'],
      q: '  acme  ',
      page: 2,
      perPage: 30,
    });

    expect(stub.rpcCalls).toEqual([
      {
        name: 'purchase_orders_page',
        args: {
          p_organization_id: 'org-test',
          p_warehouse_ids: null,
          p_statuses: ['expected_inbound', 'partially_received'],
          p_q: 'acme',
          p_limit: 30,
          p_offset: 30,
        },
      },
    ]);
    expect(result.total).toBe(41);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toHaveProperty('filtered_count');
    expect(result.rows[0]!.line_count).toBe(2); // numeric-string coerced
    expect(result.rows[0]!.po_number).toBe('PO-1002');
  });

  it("the 'all' tab and an empty q travel as NULLs (no filter legs in SQL)", async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_page': { data: [], error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.listPage({ statuses: null, q: '   ', page: 1, perPage: 30 });

    expect(stub.rpcCalls[0]!.args).toEqual({
      p_organization_id: 'org-test',
      p_warehouse_ids: null,
      p_statuses: null,
      p_q: null,
      p_limit: 30,
      p_offset: 0,
    });
    // Empty page 1 needs no probe: the filtered set IS empty.
    expect(stub.rpcCalls).toHaveLength(1);
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('an empty DEEP page (stale ?page= link) probes offset 0 to recover the true filtered total instead of misreporting "no matches"', async () => {
    allAccess();
    let call = 0;
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_page': () => {
        call += 1;
        return call === 1
          ? { data: [], error: null } // requested window is past the end
          : { data: [{ ...PAGE_ROW, filtered_count: 7 }], error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const result = await svc.listPage({ page: 99, perPage: 30 });

    expect(result).toEqual({ rows: [], total: 7 });
    expect(stub.rpcCalls).toHaveLength(2);
    expect(stub.rpcCalls[1]!.args).toMatchObject({ p_limit: 1, p_offset: 0 });
  });

  it('restricted user with ZERO readable warehouses → empty page without any query', async () => {
    restrictedTo([]);
    const stub = makeSupabaseStub();
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    await expect(svc.listPage({ page: 1, perPage: 30 })).resolves.toEqual({
      rows: [],
      total: 0,
    });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('RPC errors surface as ServiceError', async () => {
    allAccess();
    const stub = makeSupabaseStub({
      'rpc:purchase_orders_page': { data: null, error: { message: 'page boom' } },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client) as never);

    const thrown = await svc.listPage({ page: 1, perPage: 30 }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    // ServiceError sanitizes internal messages for clients — assert the code.
    expect((thrown as ServiceError).code).toBe('internal_error');
  });

  it('module gate: purchase_orders disabled → ServiceError before any warehouse/RPC work', async () => {
    allAccess();
    const stub = makeSupabaseStub();
    const svc = new PurchaseOrdersService(
      makeServiceContext(stub.client, { enabledModules: new Set() as never }) as never,
    );

    const thrown = await svc.listPage({ page: 1, perPage: 30 }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect(stub.rpcCalls).toHaveLength(0);
    expect(getWarehouseAccessMock).not.toHaveBeenCalled();
  });
});
