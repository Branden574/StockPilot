import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

// Full warehouse access by default — these tests focus on supplier
// grouping + quantity math, not warehouse scoping.
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

// Audit is fire-and-forget; stub it so it doesn't reach for a real client.
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// ItemImagesService is imported by the module but unused on this path.
vi.mock('./item-images', () => ({
  ItemImagesService: class {
    async primaryImagesForItems() {
      return new Map<string, string>();
    }
  },
}));

import { ServiceError } from './context';
import { PurchaseOrdersService } from './purchase-orders';

beforeEach(() => {
  vi.clearAllMocks();
});

type SavedLine = { item_id: string; quantity_ordered: number; unit_cost: number };
type SaveArgs = { p_supplier_id: string | null; p_lines: SavedLine[] };

/** Every save_purchase_order_draft call's args, in order. */
function saves(stub: ReturnType<typeof makeSupabaseStub>): SaveArgs[] {
  return stub.rpcCalls
    .filter((c) => c.name === 'save_purchase_order_draft')
    .map((c) => c.args as SaveArgs);
}
function savedLines(stub: ReturnType<typeof makeSupabaseStub>): SavedLine[] {
  return saves(stub).flatMap((a) => a.p_lines);
}

/** One open-PO line row as PostgREST returns the !inner embed. */
type OpenLine = { id: string; item_id: string; purchase_orders: { status: string } };

/**
 * A purchase_order_items read that behaves like the database: it applies the
 * query's own `.in('purchase_orders.status', …)` filter and `.gt()` cursor,
 * orders by the query's `.order()` column (then id), and serves the
 * `.range()` window or the `.limit()`, capped at PostgREST's 1000 rows. So a
 * test fails if the service asks for the wrong states or stops paging.
 * `onRead` runs after each page is served (to change the data between pages,
 * as a colleague's save would).
 */
function openLinesRead(lines: () => OpenLine[], onRead?: (page: number) => void) {
  let page = 0;
  return (call: MockCall) => {
    const statuses = inFilters(call).find(([c]) => c === 'purchase_orders.status')?.[1] as
      | string[]
      | undefined;
    const gt = callArgs(call, 'gt') as [keyof OpenLine, string] | undefined;
    const orderCol = ((callArgs(call, 'order') as [keyof OpenLine] | undefined)?.[0] ?? 'id') as
      | 'id'
      | 'item_id';
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const rows = lines()
      .filter((l) => (statuses ? statuses.includes(l.purchase_orders.status) : true))
      .filter((l) => (gt ? String(l[gt[0]]) > gt[1] : true))
      .sort((a, b) => cmp(a[orderCol], b[orderCol]) || cmp(a.id, b.id));
    const range = callArgs(call, 'range') as [number, number] | undefined;
    const limit = (callArgs(call, 'limit') as [number] | undefined)?.[0];
    const from = range?.[0] ?? 0;
    const to = range ? Math.min(range[1], from + 999) : Math.min((limit ?? 1000) - 1, 999);
    const data = rows.slice(from, to + 1);
    onRead?.(++page);
    return { data, error: null };
  };
}

const openLine = (n: number, itemId: string, status: string): OpenLine => ({
  id: `line-${String(n).padStart(6, '0')}`,
  item_id: itemId,
  purchase_orders: { status },
});

/**
 * Build a stub whose inventory read returns `items`, whose suppliers read
 * returns `suppliers`, and where each purchase_orders.insert returns a
 * fresh, incrementing PO id so per-supplier drafts are distinguishable.
 */
function stubFor(
  items: Array<{
    id: string;
    supplier_id: string | null;
    reorder_point: number | null;
    reorder_quantity: number | null;
    quantity_on_hand: number | null;
    unit_cost: number | null;
  }>,
  suppliers: Array<{ id: string; name: string }>,
  openLines: OpenLine[] = [],
) {
  let poSeq = 0;
  return makeSupabaseStub({
    'inventory_items.select': { data: items, error: null },
    'suppliers.select': { data: suppliers, error: null },
    'purchase_order_items.select': openLinesRead(() => openLines),
    'rpc:save_purchase_order_draft': () => {
      poSeq += 1;
      return { data: { id: `po-${poSeq}`, stamped: 0, stamp_error: null }, error: null };
    },
    'locations.select': { data: null, error: null },
    'rpc:next_po_number': () => ({ data: `PO-${poSeq + 1}`, error: null }),
  });
}

describe('PurchaseOrdersService.createDraftsFromReorderForecast', () => {
  it('groups below-par items by supplier into one draft PO each with deficit-prefilled quantities', async () => {
    // Supplier A: two below-par items. Supplier B: one. plus one healthy
    // item (on hand above reorder point) that must be ignored.
    const stub = stubFor(
      [
        // Supplier A — item 1: target = max(reorderQty 5, reorderPoint 10) = 10, on hand 2 => deficit 8
        {
          id: 'item-1',
          supplier_id: 'sup-a',
          reorder_point: 10,
          reorder_quantity: 5,
          quantity_on_hand: 2,
          unit_cost: 3,
        },
        // Supplier A — item 2: target = max(reorderQty 20, reorderPoint 8) = 20, on hand 0 => deficit 20
        {
          id: 'item-2',
          supplier_id: 'sup-a',
          reorder_point: 8,
          reorder_quantity: 20,
          quantity_on_hand: 0,
          unit_cost: 1.5,
        },
        // Supplier B — item 3: target = max(reorderQty 0, reorderPoint 6) = 6, on hand 6 => at par, deficit 0 -> still reorder up by reorder point? on hand == reorder point counts as below-par
        {
          id: 'item-3',
          supplier_id: 'sup-b',
          reorder_point: 6,
          reorder_quantity: 0,
          quantity_on_hand: 1,
          unit_cost: 4,
        },
        // Healthy item — on hand (50) above reorder point (10): excluded
        {
          id: 'item-4',
          supplier_id: 'sup-a',
          reorder_point: 10,
          reorder_quantity: 5,
          quantity_on_hand: 50,
          unit_cost: 2,
        },
      ],
      [
        { id: 'sup-a', name: 'Supplier A' },
        { id: 'sup-b', name: 'Supplier B' },
      ],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    // Two suppliers => two draft POs, no unassigned.
    expect(result.supplierCount).toBe(2);
    expect(result.createdPoIds).toHaveLength(2);
    expect(result.skipped).toBe(0);
    expect(result.supplierFailures).toHaveLength(0);

    // Inspect the lines handed to the one-transaction save (0366).
    const byItem = new Map(savedLines(stub).map((l) => [l.item_id, l]));
    // item-4 (healthy) must NOT be ordered.
    expect(byItem.has('item-4')).toBe(false);
    // Deficit math.
    expect(byItem.get('item-1')?.quantity_ordered).toBe(8);
    expect(byItem.get('item-2')?.quantity_ordered).toBe(20);
    expect(byItem.get('item-3')?.quantity_ordered).toBe(5); // 6 - 1
    // Unit cost carried through.
    expect(byItem.get('item-1')?.unit_cost).toBe(3);

    // Each created PO is a DRAFT: the save function only ever creates
    // drafts, and nothing here moves one on.
    expect(saves(stub)).toHaveLength(2);
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
    expect(result.skippedOnOpenPo).toBe(0);
  });

  it('routes items with no supplier into a single unassigned draft PO', async () => {
    const stub = stubFor(
      [
        {
          id: 'item-x',
          supplier_id: null,
          reorder_point: 10,
          reorder_quantity: 0,
          quantity_on_hand: 3,
          unit_cost: 2,
        },
        {
          id: 'item-y',
          supplier_id: 'sup-a',
          reorder_point: 4,
          reorder_quantity: 0,
          quantity_on_hand: 1,
          unit_cost: 5,
        },
      ],
      [{ id: 'sup-a', name: 'Supplier A' }],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    // One real supplier + one unassigned bucket = 2 drafts.
    expect(result.createdPoIds).toHaveLength(2);
    expect(result.unassignedCount).toBe(1);

    // The unassigned PO should have supplier_id null.
    const supplierIds = saves(stub).map((a) => a.p_supplier_id);
    expect(supplierIds).toContain(null);
    expect(supplierIds).toContain('sup-a');

    // item-x (deficit 10 - 3 = 7) is on the unassigned PO line.
    const xLine = savedLines(stub).find((l) => l.item_id === 'item-x');
    expect(xLine?.quantity_ordered).toBe(7);
  });

  it('returns nothing-to-do when no items are below par', async () => {
    const stub = stubFor([], []);
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.createdPoIds).toHaveLength(0);
    expect(result.supplierCount).toBe(0);
    expect(result.unassignedCount).toBe(0);
  });

  it('paginates the candidate fetch past the 1000-row PostgREST cap (no silently-dropped below-par items)', async () => {
    // PostgREST clamps any single response to max_rows=1000, so the old
    // .limit(5000) returned only the first 1000 below-par items — items past
    // 1000 got NO draft PO. Hand the stub successive 1000-row pages of
    // below-par, unassigned (no-supplier) items and assert every one lands on
    // the unassigned draft.
    const PAGE = 1000;
    const TOTAL = 2300;
    let page = 0;
    let poSeq = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': () => {
        const start = page * PAGE;
        const rows: Record<string, unknown>[] = [];
        for (let i = start; i < Math.min(start + PAGE, TOTAL); i += 1) {
          rows.push({
            id: `item-${i.toString().padStart(6, '0')}`,
            supplier_id: null,
            reorder_point: 10,
            reorder_quantity: 0,
            quantity_on_hand: 0,
            unit_cost: 1,
          });
        }
        page += 1;
        return { data: rows, error: null };
      },
      'suppliers.select': { data: [], error: null },
      'purchase_order_items.select': { data: [], error: null },
      'rpc:save_purchase_order_draft': () => {
        poSeq += 1;
        return { data: { id: `po-${poSeq}`, stamped: 0, stamp_error: null }, error: null };
      },
      'locations.select': { data: null, error: null },
      'rpc:next_po_number': () => ({ data: `PO-${poSeq + 1}`, error: null }),
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    // All 2300 below-par items end up on the single unassigned draft PO.
    expect(result.unassignedCount).toBe(TOTAL);
    // At least three .range() pages were issued (1000 + 1000 + 300).
    const ranges = stub.chainArgsAll.get('inventory_items.select') ?? [];
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    // The last item (past the 1000 cap) made it onto a saved line.
    expect(savedLines(stub).some((l) => l.item_id === 'item-002299')).toBe(true);
  });
});

// ─── Items already on an open PO (S3 F1) ─────────────────────────────────────

/** A below-par item: reorder point 10, 2 on hand (deficit 8). */
const belowPar = (id: string, supplier: string | null = 'sup-a') => ({
  id,
  supplier_id: supplier,
  reorder_point: 10,
  reorder_quantity: 0,
  quantity_on_hand: 2,
  unit_cost: 1,
});

describe('createDraftsFromReorderForecast — items already on an open PO', () => {
  it('(a) skips items on a draft, expected_inbound, ordered or partially_received PO and counts them', async () => {
    const stub = stubFor(
      [
        belowPar('on-draft'),
        belowPar('on-inbound'),
        belowPar('on-ordered'),
        belowPar('on-partial', null),
        belowPar('fresh'),
      ],
      [{ id: 'sup-a', name: 'Supplier A' }],
      [
        openLine(1, 'on-draft', 'draft'),
        openLine(2, 'on-inbound', 'expected_inbound'),
        openLine(3, 'on-ordered', 'ordered'),
        openLine(4, 'on-partial', 'partially_received'),
      ],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.skippedOnOpenPo).toBe(4);
    // Only the item on no open PO is drafted; the unassigned bucket is empty
    // because its only item (on-partial) is already on order.
    expect(savedLines(stub).map((l) => l.item_id)).toEqual(['fresh']);
    expect(result.createdPoIds).toHaveLength(1);
    expect(result.unassignedCount).toBe(0);
  });

  it('(b) drafts items whose only POs are received or cancelled', async () => {
    const stub = stubFor(
      [belowPar('was-received'), belowPar('was-cancelled')],
      [{ id: 'sup-a', name: 'Supplier A' }],
      [openLine(1, 'was-received', 'received'), openLine(2, 'was-cancelled', 'cancelled')],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.skippedOnOpenPo).toBe(0);
    expect(savedLines(stub).map((l) => l.item_id).sort()).toEqual(['was-cancelled', 'was-received']);
  });

  it('(c) throws when the open-PO read fails, and drafts nothing (fail closed)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [belowPar('i-1')], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': { data: null, error: { message: 'statement timeout' } },
      'rpc:save_purchase_order_draft': { data: { id: 'po-1', stamped: 0, stamp_error: null }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const thrown = await svc.createDraftsFromReorderForecast().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('internal_error');
    expect(saves(stub)).toHaveLength(0);
    expect(stub.rpcCalls.some((c) => c.name === 'next_po_number')).toBe(false);
  });

  it('(d) still skips an item whose open line is row 1001 of the open-PO read', async () => {
    // 1000 open lines for other items, then the target on the 1001st row: a
    // read that stopped at PostgREST's 1000-row cap would miss it.
    const open = Array.from({ length: 1000 }, (_, i) =>
      openLine(i, `other-${String(i).padStart(4, '0')}`, 'ordered'),
    );
    open.push(openLine(1000, 'zz-deep', 'ordered'));
    const stub = stubFor([belowPar('zz-deep'), belowPar('fresh')], [{ id: 'sup-a', name: 'A' }], open);
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.skippedOnOpenPo).toBe(1);
    expect(savedLines(stub).map((l) => l.item_id)).toEqual(['fresh']);
    // Two pages, ordered by item id, the second after a cursor (keyset).
    const reads = stub.chainsAll.get('purchase_order_items.select') ?? [];
    const readArgs = stub.chainArgsAll.get('purchase_order_items.select') ?? [];
    expect(reads).toHaveLength(2);
    expect(readArgs[0]![reads[0]!.indexOf('order')]).toEqual(['item_id', { ascending: true }]);
    expect(reads[1]).toContain('gt');
    expect(readArgs[1]![reads[1]!.indexOf('gt')]).toEqual(['item_id', 'other-0999']);
    expect(reads[1]).not.toContain('range');
  });

  it('(f) a draft saved while the open set is being paged cannot hide an item that is on order', async () => {
    // 1000 other items' lines (ids line-000000..000999) and the target's line
    // (id line-001000). Between page 1 and page 2 a colleague saves another
    // draft: its five lines are deleted and re-inserted under new ids that
    // sort last. An OFFSET read ordered by id would now find the target at
    // index 995, inside the window it already served, and skip it on page 2.
    let open: OpenLine[] = Array.from({ length: 1000 }, (_, i) =>
      openLine(i, `item-${String(i).padStart(4, '0')}`, 'draft'),
    );
    open.push(openLine(1000, 'target', 'ordered'));
    const colleagueSaves = (page: number) => {
      if (page !== 1) return;
      const moved = open.slice(0, 5).map((l, k) => ({ ...l, id: `line-9${String(k).padStart(5, '0')}` }));
      open = [...open.slice(5), ...moved];
    };
    let poSeq = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [belowPar('target'), belowPar('fresh')], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': openLinesRead(() => open, colleagueSaves),
      'rpc:next_po_number': () => ({ data: `PO-${poSeq + 1}`, error: null }),
      'rpc:save_purchase_order_draft': () => {
        poSeq += 1;
        return { data: { id: `po-${poSeq}`, stamped: 0, stamp_error: null }, error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.skippedOnOpenPo).toBe(1);
    expect(savedLines(stub).map((l) => l.item_id)).toEqual(['fresh']);
  });

  it('(e) a second click drafts nothing: the first click\'s drafts are open POs', async () => {
    // Stateful: every saved line joins the open set as a draft line, which is
    // what the database does.
    const open: OpenLine[] = [];
    let poSeq = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [belowPar('i-1'), belowPar('i-2', null)], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': openLinesRead(() => open),
      'rpc:next_po_number': () => ({ data: `PO-${poSeq + 1}`, error: null }),
      'rpc:save_purchase_order_draft': (call: MockCall) => {
        poSeq += 1;
        const args = call.args[0]?.[0] as SaveArgs;
        for (const l of args.p_lines) open.push(openLine(open.length, l.item_id, 'draft'));
        return { data: { id: `po-${poSeq}`, stamped: 0, stamp_error: null }, error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const first = await svc.createDraftsFromReorderForecast();
    const second = await svc.createDraftsFromReorderForecast();

    expect(first.createdPoIds).toHaveLength(2);
    expect(first.skippedOnOpenPo).toBe(0);
    expect(second.createdPoIds).toHaveLength(0);
    expect(second.skippedOnOpenPo).toBe(2);
    expect(saves(stub)).toHaveLength(2); // only the first click's two drafts
  });

  it('(g) every reorder draft asks the database to leave out items already on order (the lock-held re-check)', async () => {
    const stub = stubFor(
      [belowPar('a-1', 'sup-a'), belowPar('x-1', null)],
      [{ id: 'sup-a', name: 'Supplier A' }],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    await svc.createDraftsFromReorderForecast();

    const flags = stub.rpcCalls
      .filter((c) => c.name === 'save_purchase_order_draft')
      .map((c) => (c.args as { p_skip_items_on_open_po?: boolean }).p_skip_items_on_open_po);
    expect(flags).toEqual([true, true]); // the supplier draft and the unassigned one
  });

  it('(h) a run at the same moment drafted some items first: the database leaves them off, they count as skipped, and an all-skipped draft is not created', async () => {
    // Both runs read the open set before either saved. The other run's
    // drafts committed first, so the save here reports its items as skipped
    // (supplier A: one of two; unassigned: all, so no PO at all).
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [belowPar('a-1', 'sup-a'), belowPar('a-2', 'sup-a'), belowPar('x-1', null)],
        error: null,
      },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': { data: [], error: null },
      'rpc:next_po_number': { data: 'PO-9', error: null },
      'rpc:save_purchase_order_draft': (call: MockCall) => {
        const args = call.args[0]?.[0] as SaveArgs;
        return args.p_supplier_id === 'sup-a'
          ? { data: { id: 'po-a', stamped: 0, stamp_error: null, skipped_item_ids: ['a-2'] }, error: null }
          : { data: { id: null, stamped: 0, stamp_error: null, skipped_item_ids: ['x-1'] }, error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.createdPoIds).toEqual(['po-a']);
    expect(result.skippedOnOpenPo).toBe(2);
    expect(result.unassignedCount).toBe(0);
    expect(result.supplierFailures).toEqual([]);
  });

  it('(i) an explicit Items selection never asks the database to skip anything', async () => {
    const stub = stubFor([belowPar('a-1', 'sup-a')], [{ id: 'sup-a', name: 'Supplier A' }]);
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    await svc.createDraftsFromItems(['a-1']);

    const args = stub.rpcCalls.find((c) => c.name === 'save_purchase_order_draft')?.args as {
      p_skip_items_on_open_po?: boolean;
    };
    expect(args.p_skip_items_on_open_po).toBe(false);
  });

  it("reports one supplier's failed save and still creates the other supplier's draft", async () => {
    // One supplier's save fails; the other supplier's draft is still created
    // and the failure is reported, not thrown.
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [belowPar('a-1', 'sup-a'), belowPar('b-1', 'sup-b')],
        error: null,
      },
      'suppliers.select': {
        data: [
          { id: 'sup-a', name: 'Supplier A' },
          { id: 'sup-b', name: 'Supplier B' },
        ],
        error: null,
      },
      'purchase_order_items.select': { data: [], error: null },
      'rpc:next_po_number': { data: 'PO-9', error: null },
      'rpc:save_purchase_order_draft': () => {
        n += 1;
        return n === 1
          ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }
          : { data: { id: 'po-b', stamped: 0, stamp_error: null }, error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromReorderForecast();

    expect(result.createdPoIds).toEqual(['po-b']);
    expect(result.supplierFailures).toHaveLength(1);
    expect(result.supplierFailures[0]?.supplierName).toBe('Supplier A');
    expect(result.skipped).toBe(1);
  });
});

// ─── runAutoReorder shares the open-PO helper ────────────────────────────────

describe('runAutoReorder — open-PO dedupe and failed creates', () => {
  it('skips items on any open PO state via the shared helper (same read, same states)', async () => {
    const stub = stubFor(
      [belowPar('on-partial'), belowPar('on-draft'), belowPar('fresh')],
      [{ id: 'sup-a', name: 'Supplier A' }],
      [openLine(1, 'on-partial', 'partially_received'), openLine(2, 'on-draft', 'draft')],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.runAutoReorder({ enabled: true, mode: 'draft', maxAutoSendCents: null });

    expect(result.skippedDuplicate).toBe(2);
    expect(result.created).toBe(1);
    expect(savedLines(stub).map((l) => l.item_id)).toEqual(['fresh']);
    // The one open-PO read asked for exactly the four open states.
    const statuses = inFilters({
      table: 'purchase_order_items',
      op: 'select',
      methods: stub.chainsAll.get('purchase_order_items.select')![0]!,
      args: stub.chainArgsAll.get('purchase_order_items.select')![0]!,
    }).find(([c]) => c === 'purchase_orders.status')?.[1];
    expect(statuses).toEqual(['draft', 'expected_inbound', 'ordered', 'partially_received']);
  });

  it('throws when the open-PO read fails, before creating anything', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [belowPar('i-1')], error: null },
      'purchase_order_items.select': { data: null, error: { message: 'boom' } },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    await expect(
      svc.runAutoReorder({ enabled: true, mode: 'send', maxAutoSendCents: 100000 }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(saves(stub)).toHaveLength(0);
  });

  it('never marks anything ordered after a failed create (send mode)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [belowPar('i-1')], error: null },
      'purchase_order_items.select': { data: [], error: null },
      'organization_modules.select': { data: { settings: {} }, error: null },
      'rpc:next_po_number': { data: 'PO-1', error: null },
      'rpc:save_purchase_order_draft': {
        data: null,
        error: { code: '22023', hint: 'po_line_invalid', message: 'Each line needs…' },
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.runAutoReorder({ enabled: true, mode: 'send', maxAutoSendCents: 100000 });

    expect(result.created).toBe(0);
    expect(result.sent).toBe(0);
    expect(result.supplierFailures).toBe(1);
    // updateStatus reads then updates purchase_orders; neither happened.
    expect(stub.chainsAll.get('purchase_orders.update')).toBeUndefined();
    expect(stub.chainsAll.get('purchase_orders.select')).toBeUndefined();
  });
});

describe('runAutoReorder — a run at the same moment (database re-check under the reorder lock)', () => {
  const line = (id: string, cost: number, supplier = 'sup-a') => ({
    id,
    supplier_id: supplier,
    reorder_point: 1,
    reorder_quantity: 0,
    quantity_on_hand: 0,
    unit_cost: cost,
  });

  it('an all-skipped group creates nothing and is counted as a duplicate', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [line('a-1', 5)], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': { data: [], error: null },
      'rpc:next_po_number': { data: 'PO-1', error: null },
      'rpc:save_purchase_order_draft': {
        data: { id: null, stamped: 0, stamp_error: null, skipped_item_ids: ['a-1'] },
        error: null,
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.runAutoReorder({ enabled: true, mode: 'draft', maxAutoSendCents: null });

    expect(result.created).toBe(0);
    expect(result.skippedDuplicate).toBe(1);
    expect(result.supplierFailures).toBe(0);
    expect((saves(stub)[0] as unknown as { p_skip_items_on_open_po: boolean }).p_skip_items_on_open_po).toBe(true);
  });

  it('decides auto-send on what was actually drafted, not on lines the database left off', async () => {
    // Planned: a-1 ($50) + a-2 ($80) = $130, over the $100 cap. The other run
    // drafted a-2 first, so this PO carries a-1 alone ($50): under the cap.
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [line('a-1', 50), line('a-2', 80)], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': { data: [], error: null },
      'organization_modules.select': { data: { settings: {} }, error: null },
      'rpc:next_po_number': { data: 'PO-1', error: null },
      'rpc:save_purchase_order_draft': {
        data: { id: 'po-1', stamped: 0, stamp_error: null, skipped_item_ids: ['a-2'] },
        error: null,
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));
    const send = vi.spyOn(svc, 'updateStatus').mockResolvedValue(undefined as never);

    const result = await svc.runAutoReorder({ enabled: true, mode: 'send', maxAutoSendCents: 10_000 });

    expect(send).toHaveBeenCalledWith('po-1', 'ordered');
    expect(result).toMatchObject({ created: 1, sent: 1, heldForReview: 0, skippedDuplicate: 1 });
  });
});

// ─── createDraftsFromItems: an explicit selection is warned about, not skipped (D5) ───

describe('createDraftsFromItems — items already on an open PO', () => {
  const selected = (id: string) => ({
    id,
    supplier_id: 'sup-a',
    reorder_point: 10,
    reorder_quantity: 4,
    quantity_on_hand: 2,
    unit_cost: 1,
  });

  it('drafts every selected item, and counts the ones already on an open PO', async () => {
    const stub = stubFor(
      [selected('on-order'), selected('fresh')],
      [{ id: 'sup-a', name: 'Supplier A' }],
      [openLine(1, 'on-order', 'ordered'), openLine(2, 'old', 'received')],
    );
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromItems(['on-order', 'fresh']);

    // The user chose both: both are on the draft, nothing is dropped.
    expect(savedLines(stub).map((l) => l.item_id).sort()).toEqual(['fresh', 'on-order']);
    expect(result.alreadyOnOpenPo).toBe(1);
    expect(result.createdPoIds).toHaveLength(1);
  });

  it('reads the open set BEFORE drafting, so its own new draft never counts', async () => {
    const open: OpenLine[] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [selected('i-1')], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': openLinesRead(() => open),
      'rpc:next_po_number': { data: 'PO-1', error: null },
      'rpc:save_purchase_order_draft': (call: MockCall) => {
        const args = call.args[0]?.[0] as SaveArgs;
        for (const l of args.p_lines) open.push(openLine(open.length, l.item_id, 'draft'));
        return { data: { id: 'po-1', stamped: 0, stamp_error: null }, error: null };
      },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const first = await svc.createDraftsFromItems(['i-1']);
    const second = await svc.createDraftsFromItems(['i-1']);

    expect(first.alreadyOnOpenPo).toBe(0);
    expect(second.alreadyOnOpenPo).toBe(1); // the first click's draft is open now
    expect(saves(stub)).toHaveLength(2); // an explicit selection is never skipped
  });

  it('a failed open-PO read reports "unknown" (null), never 0, and still drafts the selection', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [selected('i-1')], error: null },
      'suppliers.select': { data: [{ id: 'sup-a', name: 'Supplier A' }], error: null },
      'purchase_order_items.select': { data: null, error: { message: 'statement timeout' } },
      'rpc:next_po_number': { data: 'PO-1', error: null },
      'rpc:save_purchase_order_draft': { data: { id: 'po-1', stamped: 0, stamp_error: null }, error: null },
    });
    const svc = new PurchaseOrdersService(makeServiceContext(stub.client));

    const result = await svc.createDraftsFromItems(['i-1']);

    expect(result.alreadyOnOpenPo).toBeNull();
    expect(result.createdPoIds).toEqual(['po-1']);
  });
});
