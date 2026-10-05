import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { inFilters, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
const access = vi.hoisted(() => ({ value: { hasAllAccess: true, writableIds: [] as string[], readableIds: [] as string[] } }));
vi.mock('@/lib/auth/warehouse', () => ({ getWarehouseAccess: vi.fn(async () => access.value) }));
const images = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => new Map<string, { url: string; thumbUrl: string | null }>()));
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    primaryImagesWithThumbsForItems = images;
  },
}));

import {
  buildReturnListPage,
  buildReturnWorkbench,
  decodeReturnCursor,
  encodeReturnCursor,
  orderNumberFromSearch,
  sanitizeReturnSearch,
} from './returns-workbench';

const RET = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const R31 = '44444444-4444-4444-8444-444444444444';
const itemId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const lineId = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;

function header(lines: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: RET,
    return_number: 'RMA-20261005-ABC123',
    status: 'approved',
    source: 'requester',
    reason_code: 'damaged',
    notes: null,
    denial_reason: null,
    order_request_id: ORDER,
    requester_name: null,
    requester_email: null,
    requested_by: null,
    approved_by: '55555555-5555-4555-8555-555555555555',
    approved_at: '2026-10-02T00:00:00Z',
    received_by: null,
    received_at: null,
    closed_by: null,
    closed_at: null,
    denied_by: null,
    denied_at: null,
    created_at: '2026-10-01T00:00:00Z',
    order_request: { order_number: 103, warehouse_id: WH, requester_name: 'Pat Lee', requester_email: 'pat@example.com', completed_at: '2026-09-30T00:00:00Z' },
    lines,
    ...over,
  };
}

const LINE = {
  id: lineId(1),
  order_request_line_id: 'ol-1',
  item_id: itemId(1),
  quantity: 1,
  disposition: 'restock',
  applied: false,
  created_at: '2026-10-01T00:00:00Z',
};

const OPTIONS = {
  returnId: RET,
  status: 'approved',
  planSeq: 7,
  lines: [
    {
      returnLineId: lineId(1),
      itemId: itemId(1),
      quantity: 1,
      disposition: 'restock',
      applied: false,
      plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 7 },
      case: 'single_source',
      notRecordedReason: null,
      sources: [{ locationId: R31, name: '31-C', kind: 'rack', type: 'shelf', drawn: 1, restored: 0, remaining: 1, cap: 1, valid: true, reason: null, writable: true }],
      offerOriginal: true,
      offerSourceIds: [],
      preselect: 'original',
    },
  ],
};

function ctxFor(results: Record<string, unknown>, over: Parameters<typeof makeServiceContext>[1] = {}) {
  const stub = makeSupabaseStub(results as never);
  return { stub, ctx: makeServiceContext(stub.client, { role: 'manager', enabledModules: new Set<ModuleId>(['returns', 'orders'] as ModuleId[]), ...over }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.value = { hasAllAccess: true, writableIds: [], readableIds: [] };
});

describe('buildReturnWorkbench', () => {
  it('assembles the header, the line (item, size, photo, destination options), the revision, plan seq, chain and actions', async () => {
    images.mockResolvedValueOnce(new Map([[itemId(1), { url: 'https://x/master', thumbUrl: 'https://x/thumb' }]]));
    const { ctx } = ctxFor({
      'returns.select': { data: [header([LINE])], error: null },
      'rpc:return_restock_options': { data: OPTIONS, error: null },
      'return_decisions.select': {
        data: [
          { seq: 1, kind: 'created', channel: 'token', revision: null, return_line_id: null, disposition: null, restock_target: null, location_id: null, basis: null, reason: null, actor_user_id: null, actor_kind: 'requester', created_at: '2026-10-01T00:00:00Z' },
          { seq: 7, kind: 'disposition_planned', channel: 'staff', revision: null, return_line_id: lineId(1), disposition: 'restock', restock_target: 'original', location_id: null, basis: 'single_source', reason: null, actor_user_id: '55555555-5555-4555-8555-555555555555', actor_kind: 'staff', created_at: '2026-10-02T00:00:00Z' },
          { seq: 8, kind: 'approved', channel: 'staff', revision: 1, return_line_id: null, disposition: null, restock_target: null, location_id: null, basis: null, reason: null, actor_user_id: '55555555-5555-4555-8555-555555555555', actor_kind: 'staff', created_at: '2026-10-02T00:00:00Z' },
        ],
        error: null,
      },
      'inventory_items.select': {
        data: [{ id: itemId(1), name: 'Walk New Hire Shirt', sku: 'NH-M', deleted_at: null, variant_size: 'M', variant_width: null, variant_color: null, jersey_number: null }],
        error: null,
      },
      'stock_movements.select': { data: [], error: null },
      'warehouses.select': { data: [{ id: WH, name: 'Main' }], error: null },
      'user_profiles.select': { data: [{ id: '55555555-5555-4555-8555-555555555555', full_name: 'Dana Keeler', email: null }], error: null },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(wb.return).toMatchObject({ returnNumber: 'RMA-20261005-ABC123', orderNumber: 103, warehouseName: 'Main', requesterName: 'Pat Lee', approvedByName: 'Dana Keeler' });
    expect(wb.revision).toBe(1);
    expect(wb.planSeq).toBe(7);
    expect(wb.lines[0]).toMatchObject({
      item: { name: 'Walk New Hire Shirt', variant: 'Size M', thumbUrl: 'https://x/thumb' },
      inboundState: 'Waiting',
      restock: { case: 'single_source', offerOriginal: true },
    });
    expect(wb.viewer).toEqual({ canManageReturns: true, canApproveOrders: true, canReadDecisions: true });
    expect(wb.actions).toEqual({ primary: 'receive', secondary: ['change_destination', 'cancel'], readOnlyReason: null });
    expect(wb.chain.map((e) => e.kind)).toEqual(['handed_over', 'created', 'disposition_planned', 'approved']);
    // Review: the destination names the line and the rack; the approval
    // shows no internal revision number.
    expect(wb.chain.find((e) => e.kind === 'disposition_planned')!.label).toBe(
      'Destination for Walk New Hire Shirt, M: Return to original rack 31-C',
    );
    expect(wb.chain.find((e) => e.kind === 'approved')!.label).toBe('Approved');
    expect(wb.destinationsUnavailable).toBe(false);
  });

  it('reads the RMA\'s movements from the ledger only: a member\'s direct insert is no leg (review)', async () => {
    const { ctx, stub } = ctxFor({
      'returns.select': { data: [header([LINE])], error: null },
      'rpc:return_restock_options': { data: OPTIONS, error: null },
      'return_decisions.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
      'stock_movements.select': { data: [], error: null },
    });
    await buildReturnWorkbench(ctx as never, RET);
    const reads = stub.chainArgsAll.get('stock_movements.select') ?? [];
    // The RMA's own legs and the original order's picks: both ledger rows only.
    const legs = reads.find((args) => args.some((a) => a[0] === 'reference_type' && a[1] === 'return'))!;
    const picks = reads.find((args) => args.some((a) => a[0] === 'reference_type' && a[1] === 'order_request'));
    expect(legs).toContainEqual(['via_ledger', true]);
    if (picks) expect(picks).toContainEqual(['via_ledger', true]);
  });

  it('a scrapped line reads as one "Scrapped" event, never "Into Staging" first (review)', async () => {
    const { ctx } = ctxFor({
      'returns.select': { data: [header([{ ...LINE, disposition: 'scrap', applied: true }], { status: 'closed' })], error: null },
      'rpc:return_restock_options': { data: { ...OPTIONS, status: 'closed', lines: [] }, error: null },
      'return_decisions.select': { data: [], error: null },
      'inventory_items.select': { data: [{ id: itemId(1), name: 'Shirt', sku: null, deleted_at: null }], error: null },
      'stock_movements.select': {
        data: [
          { item_id: itemId(1), movement_type: 'return', quantity_change: 1, to_location_id: null, created_at: '2026-10-03T00:00:00Z' },
          { item_id: itemId(1), movement_type: 'loss', quantity_change: -1, to_location_id: null, created_at: '2026-10-03T00:00:00Z' },
        ],
        error: null,
      },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    // (The stub answers every movement read alike; the picks are not this test's.)
    expect(wb.chain.filter((e) => e.kind !== 'picked' && e.kind !== 'handed_over').map((e) => e.label)).toEqual(['Scrapped: Shirt ×1']);
    expect(wb.lines[0]!.inboundState).toBe('Scrapped');
  });

  it('a manager without write access to the warehouse (or a revoked grant) is read-only; the database decides anyway', async () => {
    access.value = { hasAllAccess: false, writableIds: [], readableIds: [WH] };
    const { ctx } = ctxFor(
      {
        'returns.select': { data: [header([LINE])], error: null },
        'rpc:return_restock_options': { data: OPTIONS, error: null },
        'return_decisions.select': { data: [], error: null },
        'inventory_items.select': { data: [], error: null },
        'stock_movements.select': { data: [], error: null },
      },
      { role: 'staff', permissions: new Set(['returns:manage']) },
    );
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(wb.viewer.canManageReturns).toBe(false);
    expect(wb.actions.readOnlyReason).toBe("You don't have permission to manage returns.");
  });

  it('names 250 lines reading items 100 at a time; a failed batch shows the lines unnamed and is reported', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({ ...LINE, id: lineId(i + 10), item_id: itemId(i + 10) }));
    const batches: number[] = [];
    let n = 0;
    const { ctx } = ctxFor({
      'returns.select': { data: [header(lines)], error: null },
      'rpc:return_restock_options': { data: { ...OPTIONS, lines: [] }, error: null },
      'return_decisions.select': { data: [], error: null },
      'inventory_items.select': (call: MockCall) => {
        const ids = (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];
        batches.push(ids.length);
        n += 1;
        if (n === 3) return { data: null, error: { message: 'boom' } };
        return { data: ids.map((id) => ({ id, name: `Item ${id.slice(-3)}`, sku: null, deleted_at: null })), error: null };
      },
      'stock_movements.select': { data: [], error: null },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(batches.every((b) => b <= 100)).toBe(true);
    expect(wb.lines).toHaveLength(250);
    expect(reportError).toHaveBeenCalled();
  });

  it('a destination read that fails leaves the destinations out and is reported (actions are refused in the database anyway)', async () => {
    const { ctx } = ctxFor({
      'returns.select': { data: [header([LINE])], error: null },
      'rpc:return_restock_options': { data: null, error: { code: '42501', hint: 'warehouse_read', message: 'warehouse_read' } },
      'return_decisions.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
      'stock_movements.select': { data: [], error: null },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(wb.lines[0]!.restock).toBeNull();
    expect(reportError).toHaveBeenCalled();
    // Review: the screens must not approve or process with no destination
    // read (that would plan every line to Staging silently).
    expect(wb.destinationsUnavailable).toBe(true);
  });

  it('a closed line reads "Returned to 31-C" from its own movement, and the chain shows the leg', async () => {
    const { ctx } = ctxFor({
      'returns.select': { data: [header([{ ...LINE, applied: true }], { status: 'closed' })], error: null },
      'rpc:return_restock_options': { data: { ...OPTIONS, status: 'closed' }, error: null },
      'return_decisions.select': { data: [], error: null },
      'inventory_items.select': { data: [{ id: itemId(1), name: 'Shirt', sku: null, deleted_at: null }], error: null },
      'stock_movements.select': {
        data: [{ item_id: itemId(1), movement_type: 'return', quantity_change: 1, to_location_id: R31, created_at: '2026-10-03T00:00:00Z' }],
        error: null,
      },
      'locations.select': { data: [{ id: R31, name: '31-C' }], error: null },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(wb.lines[0]!.inboundState).toBe('Returned to 31-C');
    expect(wb.lines[0]!.restock).toBeNull();
    expect(wb.chain.at(-1)!.label).toBe('Returned to 31-C: Shirt ×1');
    expect(wb.actions.primary).toBeNull();
  });

  it('a missing (or foreign) RMA is not_found; a bad id never queries', async () => {
    const { ctx, stub } = ctxFor({ 'returns.select': { data: [], error: null } });
    await expect(buildReturnWorkbench(ctx as never, RET)).rejects.toMatchObject({ code: 'not_found' });
    await expect(buildReturnWorkbench(ctx as never, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(stub.fromCalls.filter((t) => t === 'returns')).toHaveLength(1);
  });

  it('created at the counter opens with "Approve and receive"', async () => {
    const { ctx } = ctxFor({
      'returns.select': { data: [header([LINE], { status: 'requested' })], error: null },
      'rpc:return_restock_options': { data: { ...OPTIONS, status: 'requested' }, error: null },
      'return_decisions.select': {
        data: [{ seq: 1, kind: 'created', channel: 'counter', revision: null, return_line_id: null, disposition: null, restock_target: null, location_id: null, basis: null, reason: null, actor_user_id: null, actor_kind: 'staff', created_at: '2026-10-01T00:00:00Z' }],
        error: null,
      },
      'inventory_items.select': { data: [], error: null },
      'stock_movements.select': { data: [], error: null },
    });
    const wb = await buildReturnWorkbench(ctx as never, RET);
    expect(wb.createdOnCounter).toBe(true);
    expect(wb.actions.primary).toBe('approve_and_receive');
  });
});

describe('buildReturnListPage', () => {
  function overview(i: number, over: Record<string, unknown> = {}) {
    return {
      id: `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`,
      return_number: `RMA-${i}`,
      status: 'requested',
      source: 'internal',
      reason_code: null,
      order_request_id: ORDER,
      order_number: 100 + i,
      requester_name: null,
      requester_email: null,
      created_at: `2026-10-0${(i % 9) + 1}T00:00:00Z`,
      approved_at: null,
      waiting_days: null,
      line_count: 3,
      unit_count: 3,
      lines: [
        { line_id: 'a', item_id: itemId(1), quantity: 1 },
        { line_id: 'b', item_id: itemId(2), quantity: 1 },
        { line_id: 'c', item_id: itemId(3), quantity: 1 },
      ],
      ...over,
    };
  }

  it('reads 26 rows for a page of 25, answers a next cursor, and shows two items then "+N" in three round trips', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => overview(i));
    images.mockResolvedValueOnce(new Map([[itemId(1), { url: 'm', thumbUrl: 't' }]]));
    const { ctx, stub } = ctxFor({
      'return_overview.select': { data: rows, error: null },
      'inventory_items.select': { data: [{ id: itemId(1), name: 'Shirt', sku: null, deleted_at: null, variant_size: 'L' }], error: null },
    });
    const page = await buildReturnListPage(ctx as never, { filter: 'all' });
    expect(page.rows).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    expect(page.rows[0]!.items).toEqual([
      { itemId: itemId(1), name: 'Shirt', variant: 'Size L', quantity: 1, thumbUrl: 't' },
      { itemId: itemId(2), name: null, variant: null, quantity: 1, thumbUrl: null },
    ]);
    expect(page.rows[0]!.moreItems).toBe(1);
    // No per-row request: one overview read, one item batch, one image call.
    expect(stub.fromCalls.filter((t) => t === 'return_overview')).toHaveLength(1);
    expect(stub.fromCalls.filter((t) => t === 'inventory_items')).toHaveLength(1);
    expect(images).toHaveBeenCalledTimes(1);
    const range = stub.chainArgs.get('return_overview.select')!.find((a) => a.length === 2 && a[0] === 0);
    expect(range).toEqual([0, 25]);
  });

  it('the waiting list filters to approved and sorts by the oldest approval', async () => {
    const { ctx, stub } = ctxFor({ 'return_overview.select': { data: [], error: null } });
    await buildReturnListPage(ctx as never, { filter: 'waiting_for_return' });
    const args = stub.chainArgs.get('return_overview.select')!;
    expect(args).toContainEqual(['status', ['approved']]);
    expect(args).toContainEqual(['approved_at', { ascending: true }]);
  });

  it('the search reaches the RMA number, the SO number and the requester through one sanitized logic tree', async () => {
    const { ctx, stub } = ctxFor({ 'return_overview.select': { data: [], error: null } });
    await buildReturnListPage(ctx as never, { q: 'SO-000103' });
    const or = stub.chainArgs.get('return_overview.select')!.find((a) => typeof a[0] === 'string' && String(a[0]).startsWith('and('));
    expect(String(or![0])).toContain('order_number.eq.103');
    expect(String(or![0])).toContain('return_number.ilike.%SO-000103%');
    await buildReturnListPage(ctx as never, { q: 'a,b)(;' });
    const or2 = stub.chainArgs.get('return_overview.select')!.find((a) => typeof a[0] === 'string' && String(a[0]).startsWith('and('));
    expect(String(or2![0])).not.toMatch(/[;]|a,b/);
  });
});

describe('list helpers', () => {
  it('round-trips a cursor and refuses a forged one', () => {
    const c = encodeReturnCursor('2026-10-05T10:00:00.123456+00:00', RET);
    expect(decodeReturnCursor(c)).toEqual({ k: '2026-10-05T10:00:00.123456+00:00', i: RET });
    expect(decodeReturnCursor(Buffer.from('{"k":"x),or(","i":"1"}').toString('base64url'))).toBeNull();
    expect(decodeReturnCursor('!!!')).toBeNull();
  });

  it('reads an SO search and sanitizes the term', () => {
    expect(orderNumberFromSearch('SO-000103')).toBe(103);
    expect(orderNumberFromSearch('so103')).toBe(103);
    expect(orderNumberFromSearch('RMA-1')).toBeNull();
    expect(sanitizeReturnSearch(' pat@example.com ')).toBe('pat@example.com');
    expect(sanitizeReturnSearch('x,y(z)"%\\')).toBe('x y z');
  });
});
