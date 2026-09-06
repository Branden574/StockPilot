import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// Full-access warehouse mock — the counts under test are org-wide
// (warehouse_id null) so the gate is never actually exercised, but the
// service imports these symbols at module load.
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

import { CycleCountsService } from './cycle-counts';

beforeEach(() => {
  vi.clearAllMocks();
});

/** One raw cycle_count_lines row with the embedded item, as get() selects it. */
function rawLine(i: number, countedQty: number | null = null) {
  return {
    id: `l${String(i).padStart(5, '0')}`,
    cycle_count_id: 'cc-1',
    item_id: `it${i}`,
    warehouse_id: null,
    expected_quantity: 1,
    counted_quantity: countedQty,
    reason: null,
    notes: null,
    counted_by: null,
    counted_at: null,
    item: {
      id: `it${i}`,
      name: `Item ${i}`,
      sku: `SKU-${String(i).padStart(5, '0')}`,
      unit_of_measure: 'ea',
      barcode: null,
    },
  };
}

describe('CycleCountsService.get — no 1000-row cap (fetchAllRows)', () => {
  it('returns EVERY line when a count has more than the PostgREST max_rows cap', async () => {
    // The PDF count sheet + variance report print all lines. A bare select
    // silently clamps to 1000; fetchAllRows must page past it. Simulate a
    // full first page (1000) followed by a short page (500) → 1500 total.
    let call = 0;
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [
          {
            id: 'cc-1',
            organization_id: 'org-test',
            warehouse_id: null,
            status: 'in_progress',
          },
        ],
        error: null,
      },
      'cycle_count_lines.select': () => {
        call += 1;
        if (call === 1) {
          return {
            data: Array.from({ length: 1000 }, (_, i) => rawLine(i)),
            error: null,
          };
        }
        return {
          data: Array.from({ length: 500 }, (_, i) => rawLine(1000 + i)),
          error: null,
        };
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const { lines } = await svc.get('cc-1');

    // 1500 > 1000 proves the tail is no longer silently dropped.
    expect(lines.length).toBe(1500);
    expect(call).toBeGreaterThanOrEqual(2);
    // Ordering preserved: in_progress → SKU ascending.
    expect(lines[0]?.item?.sku).toBe('SKU-00000');
    expect(lines[lines.length - 1]?.item?.sku).toBe('SKU-01499');
  });
});

describe('CycleCountsService.getDetailPage — server-paginated detail', () => {
  it('reshapes the line-page RPC + summary RPC and forwards search/filter/paging', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [
          {
            id: 'cc-1',
            organization_id: 'org-test',
            warehouse_id: null,
            status: 'in_progress',
          },
        ],
        error: null,
      },
      'rpc:cycle_count_lines_page': {
        data: [
          {
            id: 'l1',
            cycle_count_id: 'cc-1',
            item_id: 'it1',
            warehouse_id: 'wh-a',
            expected_quantity: '7.0000',
            counted_quantity: null,
            reason: null,
            notes: null,
            counted_by: null,
            counted_at: null,
            item_name: 'Widget',
            item_sku: 'W-1',
            item_uom: 'ea',
            item_barcode: '012345',
            full_count: 4200,
          },
        ],
        error: null,
      },
      'rpc:cycle_count_summary': {
        data: [{ total: 4200, counted: 10, variance_count: 3, net_delta: '-5.0000' }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const res = await svc.getDetailPage('cc-1', {
      page: 2,
      pageSize: 50,
      search: '  widget ',
      filter: 'uncounted',
    });

    // Filtered total comes from the window count on the page RPC.
    expect(res.total).toBe(4200);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(50);
    // Summary is the whole-count roll-up (mapped from snake_case).
    expect(res.summary).toEqual({
      total: 4200,
      counted: 10,
      varianceCount: 3,
      netDelta: -5,
    });
    // Line is reshaped into the nested-item shape the client expects.
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({
      id: 'l1',
      item_id: 'it1',
      expected_quantity: 7,
      counted_quantity: null,
      item: { id: 'it1', name: 'Widget', sku: 'W-1', unit_of_measure: 'ea', barcode: '012345' },
    });

    // Page RPC args: trimmed search, forwarded filter, SKU order (open count),
    // and offset = (page-1) * pageSize.
    const pageRpc = stub.rpcCalls.find((c) => c.name === 'cycle_count_lines_page');
    expect(pageRpc?.args).toMatchObject({
      p_cycle_count_id: 'cc-1',
      p_search: 'widget',
      p_filter: 'uncounted',
      p_order: 'sku',
      p_limit: 50,
      p_offset: 50,
    });
    const sumRpc = stub.rpcCalls.find((c) => c.name === 'cycle_count_summary');
    expect(sumRpc?.args).toMatchObject({ p_cycle_count_id: 'cc-1' });
  });

  it('orders closed counts by most-recent activity and empty search → null', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': {
        data: [
          {
            id: 'cc-2',
            organization_id: 'org-test',
            warehouse_id: null,
            status: 'completed',
          },
        ],
        error: null,
      },
      'rpc:cycle_count_lines_page': { data: [], error: null },
      'rpc:cycle_count_summary': {
        data: [{ total: 0, counted: 0, variance_count: 0, net_delta: 0 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const res = await svc.getDetailPage('cc-2', { page: 1, pageSize: 50, search: '', filter: 'all' });

    expect(res.total).toBe(0);
    expect(res.lines).toEqual([]);
    const pageRpc = stub.rpcCalls.find((c) => c.name === 'cycle_count_lines_page');
    expect(pageRpc?.args).toMatchObject({
      p_order: 'recent',
      p_search: null,
      p_filter: 'all',
      p_offset: 0,
    });
  });

  /** One reshaped RPC line row carrying the window count. */
  function rpcLine(i: number, fullCount: number) {
    return {
      id: `l${String(i).padStart(5, '0')}`,
      cycle_count_id: 'cc-1',
      item_id: `it${i}`,
      warehouse_id: null,
      expected_quantity: 1,
      counted_quantity: null,
      reason: null,
      notes: null,
      counted_by: null,
      counted_at: null,
      item_name: `Item ${i}`,
      item_sku: `SKU-${String(i).padStart(5, '0')}`,
      item_uom: 'ea',
      item_barcode: null,
      full_count: fullCount,
    };
  }

  const HEADER_RESULT = {
    data: [
      {
        id: 'cc-1',
        organization_id: 'org-test',
        warehouse_id: null,
        status: 'in_progress',
      },
    ],
    error: null,
  };

  it('CLAMPS a past-end page to the real last page: last-page rows + honest total + effective page (deterministic repro: counting the last uncounted line keeps ?page=N past the end)', async () => {
    // 120 filtered lines, pageSize 50 → 3 real pages. The URL asks for
    // page 5 (offset 200): empty window → probe offset 0 recovers
    // total=120 → the service fetches page 3 (offset 100, 20 rows) and
    // reports page 3 as the effective page.
    // The results map can't see call args, but the stub pushes onto
    // rpcCalls BEFORE resolving — so a late-bound reference lets the
    // handler dispatch on the offset the service actually asked for.
    const ref: { stub: SupabaseStub | null } = { stub: null };
    const stub = makeSupabaseStub({
      'cycle_counts.select': HEADER_RESULT,
      'rpc:cycle_count_lines_page': () => {
        const args = ref.stub!.rpcCalls
          .filter((c) => c.name === 'cycle_count_lines_page')
          .at(-1)?.args as { p_limit: number; p_offset: number };
        if (args.p_offset >= 150) return { data: [], error: null }; // past-end window
        if (args.p_offset === 0 && args.p_limit === 1) {
          return { data: [rpcLine(0, 120)], error: null }; // honest-total probe
        }
        // Real last page: offset 100 → the tail 20 rows.
        return {
          data: Array.from({ length: 20 }, (_, i) => rpcLine(100 + i, 120)),
          error: null,
        };
      },
      'rpc:cycle_count_summary': {
        data: [{ total: 200, counted: 80, variance_count: 0, net_delta: 0 }],
        error: null,
      },
    });
    ref.stub = stub;
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const res = await svc.getDetailPage('cc-1', {
      page: 5,
      pageSize: 50,
      filter: 'uncounted',
    });

    // Honest filtered total — NOT the empty window's phantom 0.
    expect(res.total).toBe(120);
    // Effective page = the real last page, so the paginator shows 3 of 3.
    expect(res.page).toBe(3);
    // …and the counter lands on that page's ACTUAL rows.
    expect(res.lines).toHaveLength(20);
    expect(res.lines[0]?.item?.sku).toBe('SKU-00100');

    // Call shape: requested window → probe(1, 0) → last page(50, 100).
    const calls = stub.rpcCalls.filter((c) => c.name === 'cycle_count_lines_page');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toMatchObject({ p_limit: 50, p_offset: 200, p_filter: 'uncounted' });
    expect(calls[1]?.args).toMatchObject({ p_limit: 1, p_offset: 0, p_filter: 'uncounted' });
    expect(calls[2]?.args).toMatchObject({ p_limit: 50, p_offset: 100, p_filter: 'uncounted' });
  });

  it('genuinely empty filtered set on a deep page → true empty state (total 0, effective page 1), no last-page fetch', async () => {
    const stub = makeSupabaseStub({
      'cycle_counts.select': HEADER_RESULT,
      'rpc:cycle_count_lines_page': { data: [], error: null },
      'rpc:cycle_count_summary': {
        data: [{ total: 200, counted: 200, variance_count: 0, net_delta: 0 }],
        error: null,
      },
    });
    const svc = new CycleCountsService(makeServiceContext(stub.client));

    const res = await svc.getDetailPage('cc-1', {
      page: 4,
      pageSize: 50,
      filter: 'uncounted',
    });

    expect(res.total).toBe(0);
    expect(res.lines).toEqual([]);
    // Normalized to page 1 so the UI renders "no items match" with no
    // phantom paginator.
    expect(res.page).toBe(1);
    // Requested window + probe only — an empty set has no last page to fetch.
    const calls = stub.rpcCalls.filter((c) => c.name === 'cycle_count_lines_page');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toMatchObject({ p_limit: 1, p_offset: 0 });
  });
});

/**
 * SP-091: getLineSetForAiScan built the vision prompt's "only consider these
 * titles" set from a bare `.select()` on cycle_count_lines. PostgREST clamps
 * that to `[api] max_rows = 1000` (pattern #3), so on a bigger count every
 * book past row 1000 was invisible to the model — scanning its shelf returned
 * "not in this count" and the line stayed uncounted. Its sibling read in this
 * same file (get()) has been paginated since the count-sheet fix above.
 */
describe('CycleCountsService.getLineSetForAiScan — no 1000-row cap', () => {
  const aiModules = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'ai_shelf_scan']);

  function bookLine(i: number) {
    return {
      id: `ln-${i}`,
      item: {
        sku: `SKU-${String(i).padStart(5, '0')}`,
        name: `Book ${i}`,
        barcode: '9780000000001',
        item_type: 'book',
        custom_fields: { author: 'A. Author' },
      },
    };
  }

  it('pages past the cap so a title on line 1200 is still offered to the model', async () => {
    let call = 0;
    const stub = makeSupabaseStub({
      // warehouse_id set → assertSessionAccess takes the early return and does
      // not spend any cycle_count_lines pages of its own.
      'cycle_counts.select': {
        data: [
          {
            id: 'cc-1',
            organization_id: 'org-test',
            warehouse_id: 'wh-a',
            status: 'in_progress',
            assigned_to: null,
          },
        ],
        error: null,
      },
      'cycle_count_lines.select': () => {
        call += 1;
        if (call === 1) {
          return { data: Array.from({ length: 1000 }, (_, i) => bookLine(i)), error: null };
        }
        return { data: Array.from({ length: 500 }, (_, i) => bookLine(1000 + i)), error: null };
      },
    });
    const svc = new CycleCountsService(
      makeServiceContext(stub.client, { enabledModules: aiModules }),
    );

    const lines = await svc.getLineSetForAiScan('cc-1');

    expect(lines.length).toBe(1500);
    expect(call).toBeGreaterThanOrEqual(2);
    expect(lines[lines.length - 1]?.sku).toBe('SKU-01499');
  });
});
