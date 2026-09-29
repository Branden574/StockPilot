// Security invariant: Book Order Totals (migrations 0379 and 0382). The one server
// method behind the page, the /api/v1 routes and the exports: the gate
// (reports:read with the MFA step-up, then the orders and books modules)
// runs before any read; the organization is the verified context's, never
// the client's; database errors map to fixed words (never raw text); a hidden
// book is not_found; a drill-down row links only for orders:approve or the
// caller's own order and `mine` itself is never passed on; covers are
// resolved only for books the caller's own RLS read returned and only from
// trusted URLs; an export is ONE export-mode statement, refused above its
// ceiling and checked against itself before any byte is written. The ORDER's
// charter (0382) reaches the database only when used (p_charter_id for a
// charter, p_no_charter for No charter, neither for All charters); a charter
// the caller may not report on is ONE validation error with one message
// whatever the cause; an answer is used only if it echoes the charter asked.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co' } }));
vi.mock('@/lib/warehouse-filter', () => ({ getActiveWarehouseFilter: vi.fn(async () => null) }));
const primaryMasterUrlsForItems = vi.fn(
  async (_ids: string[], _opts?: { imaged?: Set<string> }) => new Map<string, string>(),
);
vi.mock('./item-images', () => ({ ItemImagesService: vi.fn() }));

import { reportError } from '@/lib/error-reporter';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

import { ItemImagesService } from './item-images';

import {
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_INVALID_CHARTER,
  BOOK_REPORT_PDF_MAX_ROWS,
  DEFAULT_BOOK_REPORT_QUERY,
  type BookReportQuery,
  type ModuleId,
} from '@stockpilot/core';

import {
  BookOrderTotalsService,
  bookReportCharterArgs,
  mapBookReportRpcError,
  resolveBookReportWarehouse,
  warehouseFromResolvedQuery,
} from './book-order-totals';
import { ServiceError } from './context';

const ORG = '0e000000-0000-4000-8000-00000000000a';
const W1 = '0e000000-0000-4000-8000-0000000000d1';
const ITEM_A = '0e000000-0000-4000-8000-000000000f01';
const ITEM_B = '0e000000-0000-4000-8000-000000000f02';
const HIDDEN = '0e000000-0000-4000-8000-000000000f09';
const O1 = '0e000000-0000-4000-8000-000000000101';
const O3 = '0e000000-0000-4000-8000-000000000103';
const CH_A = '0e000000-0000-4000-8000-0000000000a1';
const CH_B = '0e000000-0000-4000-8000-0000000000a2';
const ALDER = { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' };
/** The 0382 filters echo: All charters, one charter, or No charter. */
const ECHO_ALL = { charter: null, noCharter: false };
const echoOf = (charter: typeof ALDER | null, noCharter = false) => ({ charter, noCharter });

const RANGE = {
  key: 'all',
  from: null,
  to: null,
  timeZone: 'America/Los_Angeles',
  timeZoneFallback: false,
};
const DEFAULT_11 = [
  'pending_approval',
  'approved',
  'pick_slip_generated',
  'picking_in_progress',
  'picking_complete',
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'backordered',
  'completed',
];

function row(itemId: string, copies: string, extra: Record<string, unknown> = {}) {
  return {
    itemId,
    name: `Book ${itemId.slice(-2)}`,
    sku: 'BK',
    identifier: null,
    binLocation: null,
    unit: 'unit',
    countsAsCopies: true,
    warehouseId: W1,
    warehouseName: 'North',
    itemStatus: 'active',
    deleted: false,
    nowRental: false,
    copies,
    orders: 1,
    lines: 1,
    latestOrderAt: '2026-03-01T07:30:00+00:00',
    latestOrderDate: '2026-02-28',
    fulfilled: '0',
    returned: '0',
    ...extra,
  };
}

function totalsAnswer(rows: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    range: RANGE,
    statuses: DEFAULT_11,
    filters: { warehouse: null, category: null, uncategorized: false },
    scope: { restricted: false },
    summary: {
      copies: '34',
      entries: rows.length,
      orders: 3,
      lines: 4,
      firstOrderAt: null,
      lastOrderAt: null,
      firstOrderDate: null,
      lastOrderDate: null,
      unresolved: { entries: 0, quantity: '0' },
    },
    totalCount: rows.length,
    mode: 'page',
    tooMany: false,
    maxRows: null,
    page: 1,
    pageSize: 25,
    sort: 'copies',
    rows,
    ...over,
  };
}

function ordersAnswer(found: boolean, rows: Array<Record<string, unknown>>) {
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    found,
    book: found
      ? {
          itemId: ITEM_A,
          name: 'Book A',
          sku: 'BK-A',
          identifier: null,
          binLocation: null,
          unit: 'unit',
          countsAsCopies: true,
          warehouseId: W1,
          warehouseName: 'North',
          itemStatus: 'active',
          deleted: false,
          nowRental: false,
        }
      : null,
    range: RANGE,
    statuses: DEFAULT_11,
    filters: { warehouse: null },
    totals: {
      copies: found ? '15' : '0',
      orders: rows.length,
      lines: rows.length,
      fulfilled: '0',
      returned: '0',
    },
    totalCount: rows.length,
    page: 1,
    pageSize: 25,
    rows,
  };
}

function orderRow(orderId: string, mine: boolean) {
  return {
    orderId,
    orderNumber: 1,
    createdAt: '2026-03-01T07:30:00+00:00',
    orderDate: '2026-02-28',
    status: 'approved',
    warehouseId: W1,
    warehouseName: 'North',
    copies: '5',
    fulfilled: '0',
    returned: '0',
    lines: 1,
    lineIds: ['l'],
    mine,
  };
}

const ALL: BookReportQuery = { ...DEFAULT_BOOK_REPORT_QUERY, warehouse: 'all' };
const ALL_W = { id: null, source: 'all' as const };

function service(
  results: Parameters<typeof makeSupabaseStub>[0],
  over: Parameters<typeof makeServiceContext>[1] = {},
) {
  const stub = makeSupabaseStub(results);
  const ctx = makeServiceContext(stub.client, { organizationId: ORG, role: 'manager', ...over });
  return { stub, svc: new BookOrderTotalsService(ctx as never) };
}

beforeEach(() => {
  vi.clearAllMocks();
  primaryMasterUrlsForItems.mockReset();
  primaryMasterUrlsForItems.mockImplementation(async () => new Map());
  vi.mocked(ItemImagesService).mockImplementation(function () {
    return { primaryMasterUrlsForItems };
  } as never);
});

describe('gate: before any read', () => {
  it('an MFA step-up is refused with its reason and no RPC runs', async () => {
    const { stub, svc } = service({}, { mfaRequired: true, mfaSatisfied: false });
    await expect(svc.page(ALL, ALL_W)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'mfa_required' },
    });
    expect(stub.rpcCalls).toEqual([]);
  });
  it('without reports:read: forbidden, no RPC', async () => {
    const { stub, svc } = service({}, { permissions: new Set(['items:read']) });
    await expect(svc.options()).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });
  it.each(['orders', 'books'] as ModuleId[])(
    'the %s module off: module_disabled, no RPC',
    async (off) => {
      const modules = new Set<ModuleId>(
        ['reports', 'orders', 'books', 'inventory'].filter((m) => m !== off) as ModuleId[],
      );
      const { stub, svc } = service({}, { enabledModules: modules });
      await expect(svc.covers([ITEM_A])).rejects.toMatchObject({ code: 'module_disabled' });
      expect(stub.rpcCalls).toEqual([]);
      expect(stub.fromCalls).toEqual([]);
    },
  );
});

describe('page', () => {
  it('sends the verified organization and the resolved warehouse, never anything client-supplied', async () => {
    const { stub, svc } = service({
      'rpc:book_order_totals': { data: totalsAnswer([row(ITEM_A, '30')]), error: null },
    });
    const q: BookReportQuery = {
      ...ALL,
      warehouse: W1,
      warehouseFromView: true,
      category: 'none',
      q: '0-14-044913-2',
      page: 2,
    };
    const res = await svc.page(q, { id: W1, source: 'view' });
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'book_order_totals',
      args: {
        p_organization_id: ORG,
        p_range: 'all',
        p_from_date: null,
        p_to_date: null,
        p_statuses: DEFAULT_11,
        p_warehouse_id: W1,
        p_category_id: null,
        p_uncategorized: true,
        p_search: '0-14-044913-2',
        p_isbn_keys: ['0140449132', '9780140449136'],
        p_sort: 'copies',
        p_page: 2,
        p_page_size: 25,
        p_all_rows: false,
        p_max_rows: null,
      },
    });
    expect(res.organizationId).toBe(ORG);
    expect(res.warehouse).toEqual({ id: W1, source: 'view' });
  });
  it('a malformed answer is an internal error, never an empty report', async () => {
    const { svc } = service({ 'rpc:book_order_totals': { data: { v: 1, rows: [] }, error: null } });
    await expect(svc.page(ALL, ALL_W)).rejects.toMatchObject({ code: 'internal_error' });
    expect(reportError).toHaveBeenCalled();
  });
});

describe('mapBookReportRpcError', () => {
  it.each([
    [{ code: '42501', hint: 'forbidden', message: 'forbidden' }, 'forbidden', undefined],
    [
      { code: '42501', hint: 'unauthenticated', message: 'unauthenticated' },
      'unauthenticated',
      undefined,
    ],
    [
      { code: '42501', message: 'permission denied for function book_order_totals' },
      'forbidden',
      undefined,
    ],
    [
      { code: 'P0001', hint: 'module_disabled', message: 'module disabled' },
      'module_disabled',
      undefined,
    ],
    [
      { code: '22023', hint: 'invalid_warehouse', message: 'invalid warehouse' },
      'validation_error',
      'invalid_warehouse',
    ],
    [
      { code: '22023', hint: 'invalid_category', message: 'invalid category' },
      'validation_error',
      'invalid_category',
    ],
    [
      { code: '22023', hint: 'invalid_range', message: 'invalid range' },
      'validation_error',
      'invalid_range',
    ],
    [{ code: '22023', hint: 'invalid_status', message: 'x' }, 'validation_error', 'invalid_status'],
    [
      { code: '57014', message: 'canceling statement due to statement timeout' },
      'internal_error',
      'timeout',
    ],
    [
      { code: 'PGRST202', message: 'Could not find the function public.book_order_totals' },
      'internal_error',
      undefined,
    ],
    [
      { code: '22023', hint: 'something_else', message: 'relation "x" column "y"' },
      'internal_error',
      undefined,
    ],
  ])('%j -> %s', (err, code, reason) => {
    const e = mapBookReportRpcError(err, 'test');
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe(code);
    if (reason) expect(e.details?.reason).toBe(reason);
    // The public message never carries the database text.
    expect(e.message).not.toMatch(/relation|column|function public|statement timeout|PGRST/);
  });
});

describe('orders (drill-down)', () => {
  it('found:false is not_found (a hidden book, a product and a missing id alike)', async () => {
    const { svc } = service({
      'rpc:book_order_totals_orders': { data: ordersAnswer(false, []), error: null },
    });
    await expect(svc.orders(HIDDEN, ALL, ALL_W, 1)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('an approver may open every order; `mine` is not passed on', async () => {
    const { svc } = service({
      'rpc:book_order_totals_orders': {
        data: ordersAnswer(true, [orderRow(O1, false), orderRow(O3, true)]),
        error: null,
      },
    });
    const res = await svc.orders(ITEM_A, ALL, ALL_W, 1);
    expect(res.rows.map((r) => r.openable)).toEqual([true, true]);
    for (const r of res.rows) expect(r).not.toHaveProperty('mine');
  });
  it('a reports:read holder without orders:approve may open only their own order', async () => {
    const { stub, svc } = service(
      {
        'rpc:book_order_totals_orders': {
          data: ordersAnswer(true, [orderRow(O1, false), orderRow(O3, true)]),
          error: null,
        },
      },
      { role: 'viewer', permissions: new Set(['reports:read', 'items:read']) },
    );
    const res = await svc.orders(ITEM_A, { ...ALL, category: 'none', q: 'ignored' }, ALL_W, 3);
    expect(res.rows.map((r) => [r.orderId, r.openable])).toEqual([
      [O1, false],
      [O3, true],
    ]);
    // Item filters never reach the drill-down; the page does.
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_item_id: ITEM_A,
      p_page: 3,
      p_page_size: 25,
      p_organization_id: ORG,
    });
    expect(stub.rpcCalls[0]!.args).not.toHaveProperty('p_search');
  });
  it('a malformed item id is refused before any read', async () => {
    const { stub, svc } = service({});
    await expect(svc.orders('not-a-uuid', ALL, ALL_W, 1)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.rpcCalls).toEqual([]);
  });
});

describe('options', () => {
  it("resolves the organization's status labels and drops the raw config", async () => {
    const { svc } = service({
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [{ id: W1, name: 'North', status: 'archived' }],
          categories: [],
          uncategorized: true,
          orderStatusConfig: { completed: { label: 'Handed over' } },
        },
        error: null,
      },
    });
    const res = await svc.options();
    expect(res.statusLabels.completed).toBe('Handed over');
    expect(res).not.toHaveProperty('orderStatusConfig');
    expect(res.organizationId).toBe(ORG);
  });
});

describe('warehouse resolution', () => {
  it('the page applies the warehouse view only when the URL names no warehouse', async () => {
    vi.mocked(getActiveWarehouseFilter).mockResolvedValue(W1);
    expect(await resolveBookReportWarehouse(DEFAULT_BOOK_REPORT_QUERY)).toEqual({
      id: W1,
      source: 'view',
    });
    expect(await resolveBookReportWarehouse(ALL)).toEqual({ id: null, source: 'all' });
    const other = '0e000000-0000-4000-8000-0000000000d2';
    expect(await resolveBookReportWarehouse({ ...ALL, warehouse: other })).toEqual({
      id: other,
      source: 'explicit',
    });
    vi.mocked(getActiveWarehouseFilter).mockResolvedValue(null);
    expect(await resolveBookReportWarehouse(DEFAULT_BOOK_REPORT_QUERY)).toEqual({
      id: null,
      source: 'all',
    });
  });
  it('a v1 query must name its warehouse; the view cookie is never read', () => {
    expect(() => warehouseFromResolvedQuery(DEFAULT_BOOK_REPORT_QUERY)).toThrow(ServiceError);
    expect(getActiveWarehouseFilter).not.toHaveBeenCalled();
    expect(warehouseFromResolvedQuery({ ...ALL, warehouse: W1, warehouseFromView: true })).toEqual({
      id: W1,
      source: 'view',
    });
  });
});

describe('covers', () => {
  function readableItems(ids: string[]) {
    return (call: MockCall) => {
      const batch = call.args[call.methods.indexOf('in')]?.[1] as string[];
      return { data: batch.filter((id) => ids.includes(id)).map((id) => ({ id })), error: null };
    };
  }
  it("only ids the caller's RLS read returned reach ItemImagesService", async () => {
    const { stub, svc } = service({ 'inventory_items.select': readableItems([ITEM_A]) });
    primaryMasterUrlsForItems.mockResolvedValue(
      new Map([
        [
          ITEM_A,
          'https://proj.supabase.co/storage/v1/object/sign/item-images/o/i/cover.webp?token=t',
        ],
      ]),
    );
    const covers = await svc.covers([ITEM_A, HIDDEN]);
    expect(primaryMasterUrlsForItems).toHaveBeenCalledWith([ITEM_A], { imaged: expect.any(Set) });
    expect(Object.keys(covers)).toEqual([ITEM_A]);
    // The authorizing read is the caller's own, scoped to books of this org.
    const chain = stub.chainArgsAll.get('inventory_items.select')![0]!;
    expect(chain).toEqual(
      expect.arrayContaining([
        ['organization_id', ORG],
        ['item_type', 'book'],
        ['is_bundle', false],
      ]),
    );
  });
  it('drops an untrusted URL and keeps an allowlisted cover host', async () => {
    const { svc } = service({ 'inventory_items.select': readableItems([ITEM_A, ITEM_B]) });
    primaryMasterUrlsForItems.mockResolvedValue(
      new Map([
        [ITEM_A, 'http://169.254.169.254/latest/meta-data'],
        [ITEM_B, 'https://covers.openlibrary.org/b/id/1-L.jpg'],
      ]),
    );
    expect(await svc.covers([ITEM_A, ITEM_B])).toEqual({
      [ITEM_B]: 'https://covers.openlibrary.org/b/id/1-L.jpg',
    });
  });
  it('a failed signing answers with what resolved ({}), reported with counts only', async () => {
    const { svc } = service({ 'inventory_items.select': readableItems([ITEM_A]) });
    primaryMasterUrlsForItems.mockRejectedValue(new Error('sign failed https://x/?token=secret'));
    expect(await svc.covers([ITEM_A])).toEqual({});
    const extra = vi.mocked(reportError).mock.calls.at(-1)![1].extra;
    expect(extra).toEqual({ count: 1, failed: 1 });
  });
  it('coverLookup: a failed lookup is "could not be loaded", never "no cover"', async () => {
    const { svc } = service({ 'inventory_items.select': readableItems([ITEM_A, ITEM_B]) });
    primaryMasterUrlsForItems.mockRejectedValue(new Error('sign failed'));
    expect(await svc.coverLookup([ITEM_A, ITEM_B])).toEqual({
      urls: {},
      unresolved: [ITEM_A, ITEM_B],
    });
  });
  it('coverLookup: an image that could not be signed and an untrusted URL are unresolved; a book with no image and a book the caller cannot read are not', async () => {
    const C = '0e000000-0000-4000-8000-000000000f0c';
    const { svc } = service({ 'inventory_items.select': readableItems([ITEM_A, ITEM_B, C]) });
    primaryMasterUrlsForItems.mockImplementation(
      async (_ids: string[], opts?: { imaged?: Set<string> }) => {
        // A has an image row that failed to sign; C has an untrusted URL; B has none.
        opts?.imaged?.add(ITEM_A);
        opts?.imaged?.add(C);
        return new Map([[C, 'http://169.254.169.254/latest/meta-data']]);
      },
    );
    const got = await svc.coverLookup([ITEM_A, ITEM_B, C, HIDDEN]);
    expect(got.urls).toEqual({});
    expect([...got.unresolved].sort()).toEqual([ITEM_A, C].sort());
  });
  it('pdfCovers answers the lookup (urls and unresolved) for the first 500 rows', async () => {
    const { svc } = service({ 'inventory_items.select': readableItems([ITEM_A]) });
    primaryMasterUrlsForItems.mockRejectedValue(new Error('down'));
    expect(await svc.pdfCovers([ITEM_A])).toEqual({ urls: {}, unresolved: [ITEM_A] });
  });
  it('refuses more ids than the page size', async () => {
    const { svc } = service({});
    const ids = Array.from(
      { length: 26 },
      (_, i) => `0e000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await expect(svc.covers(ids)).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'too_many_ids' },
    });
    expect(await svc.covers([])).toEqual({});
  });
});

describe('exportRows: one statement, never truncated', () => {
  it.each([
    ['csv', BOOK_REPORT_CSV_MAX_ROWS],
    ['pdf', BOOK_REPORT_PDF_MAX_ROWS],
  ] as const)('%s: exactly ONE export-mode RPC with the format ceiling', async (format, limit) => {
    const rows = [row(ITEM_A, '30'), row(ITEM_B, '4')];
    const { stub, svc } = service({
      'rpc:book_order_totals': {
        data: totalsAnswer(rows, { mode: 'all', pageSize: null, maxRows: limit }),
        error: null,
      },
    });
    const res = await svc.exportRows(ALL, ALL_W, format);
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_all_rows: true,
      p_max_rows: limit,
      p_page: 1,
      p_page_size: null,
    });
    expect(res.rows).toHaveLength(2);
  });
  it('without reports:export: forbidden before the export-mode RPC (the database refuses it too)', async () => {
    const { stub, svc } = service(
      {},
      { permissions: new Set(['reports:read', 'orders:read', 'items:read']) },
    );
    await expect(svc.exportRows(ALL, ALL_W, 'csv')).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls).toEqual([]);
  });
  it('the SQL clamp (0382, the live book_order_totals) equals the largest per-format ceiling', () => {
    // Found by its name, not its number, so a renumber of the charter-dates
    // migration is followed (core's literal pins do the same).
    const dir = path.resolve(__dirname, '../../../../../supabase/migrations');
    const files = readdirSync(dir).filter((f) =>
      /^\d+_book_order_totals_charter_dates\.sql$/.test(f),
    );
    expect(files).toHaveLength(1);
    const sql = readFileSync(path.join(dir, files[0]!), 'utf8');
    const re = /v_cap\s+integer := least\(greatest\(coalesce\(p_max_rows, (\d+)\), 1\), (\d+)\);/g;
    const all = [...sql.matchAll(re)];
    // One clamp: book_order_totals is the only export-mode function.
    expect(all).toHaveLength(1);
    const largest = Math.max(BOOK_REPORT_CSV_MAX_ROWS, BOOK_REPORT_PDF_MAX_ROWS);
    expect([Number(all[0]![1]), Number(all[0]![2])]).toEqual([largest, largest]);
  });
  it('above the ceiling: 400 too_many_rows with the counts, before any file', async () => {
    const { svc } = service({
      'rpc:book_order_totals': {
        data: totalsAnswer([], {
          mode: 'all',
          tooMany: true,
          totalCount: 21340,
          pageSize: null,
          maxRows: 20000,
          summary: { ...totalsAnswer([]).summary, entries: 21340 },
        }),
        error: null,
      },
    });
    await expect(svc.exportRows(ALL, ALL_W, 'csv')).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Too many books for one file (21,340; the limit is 20,000). Narrow the filters.',
      details: { reason: 'too_many_rows', count: 21340, limit: 20000 },
    });
  });
  it.each([
    ['a duplicated row', [row(ITEM_A, '30'), row(ITEM_A, '4')], '34'],
    ['copies that do not add up to the summary', [row(ITEM_A, '30'), row(ITEM_B, '3')], '34'],
  ])('%s is an internal error, never a partial file', async (_label, rows, copies) => {
    const base = totalsAnswer(rows, { mode: 'all', pageSize: null, maxRows: 20000 });
    const { svc } = service({
      'rpc:book_order_totals': {
        data: { ...base, summary: { ...base.summary, copies } },
        error: null,
      },
    });
    await expect(svc.exportRows(ALL, ALL_W, 'csv')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('the ORDER charter (0382)', () => {
  const CHARTER: BookReportQuery = { ...ALL, charter: CH_A };
  const NONE: BookReportQuery = { ...ALL, charter: 'none' };
  const charterKeys = (args: unknown) =>
    Object.fromEntries(
      Object.entries(args as Record<string, unknown>).filter(([k]) => /charter/.test(k)),
    );

  it('bookReportCharterArgs: a charter id, No charter, or nothing at all (D18)', () => {
    expect(bookReportCharterArgs({ charterId: null, noCharter: false })).toEqual({});
    expect(bookReportCharterArgs({ charterId: CH_A, noCharter: false })).toEqual({
      p_charter_id: CH_A,
    });
    expect(bookReportCharterArgs({ charterId: null, noCharter: true })).toEqual({
      p_no_charter: true,
    });
  });

  describe.each([
    [
      'page',
      'rpc:book_order_totals',
      (answer: Record<string, unknown>) => totalsAnswer([row(ITEM_A, '30')], answer),
      (svc: BookOrderTotalsService, q: BookReportQuery) => svc.page(q, ALL_W),
    ],
    [
      'drill-down',
      'rpc:book_order_totals_orders',
      (answer: Record<string, unknown>) => ({
        ...ordersAnswer(true, [orderRow(O1, false)]),
        filters: { warehouse: null, ...(answer.filters as object) },
      }),
      (svc: BookOrderTotalsService, q: BookReportQuery) => svc.orders(ITEM_A, q, ALL_W, 1),
    ],
    [
      'export',
      'rpc:book_order_totals',
      (answer: Record<string, unknown>) =>
        totalsAnswer([row(ITEM_A, '34')], {
          mode: 'all',
          pageSize: null,
          maxRows: 20000,
          ...answer,
        }),
      (svc: BookOrderTotalsService, q: BookReportQuery) => svc.exportRows(q, ALL_W, 'csv'),
    ],
  ] as const)('%s', (_label, key, answerOf, call) => {
    const filtersOf = (echo: Record<string, unknown> | null) => ({
      filters: { warehouse: null, category: null, uncategorized: false, ...(echo ?? {}) },
    });

    it('All charters sends NEITHER charter key, so it runs on 0379 and 0382 alike', async () => {
      // An answer with no charter keys at all is a server before 0382.
      for (const echo of [null, ECHO_ALL]) {
        const { stub, svc } = service({ [key]: { data: answerOf(filtersOf(echo)), error: null } });
        await call(svc, ALL);
        expect(stub.rpcCalls).toHaveLength(1);
        expect(charterKeys(stub.rpcCalls[0]!.args)).toEqual({});
        expect(stub.rpcCalls[0]!.args).not.toHaveProperty('p_charter_id');
        expect(stub.rpcCalls[0]!.args).not.toHaveProperty('p_no_charter');
      }
    });

    it('a charter sends exactly p_charter_id', async () => {
      const { stub, svc } = service({
        [key]: { data: answerOf(filtersOf(echoOf(ALDER))), error: null },
      });
      await call(svc, CHARTER);
      expect(charterKeys(stub.rpcCalls[0]!.args)).toEqual({ p_charter_id: CH_A });
    });

    it('No charter sends exactly p_no_charter: true', async () => {
      const { stub, svc } = service({
        [key]: { data: answerOf(filtersOf(echoOf(null, true))), error: null },
      });
      await call(svc, NONE);
      expect(charterKeys(stub.rpcCalls[0]!.args)).toEqual({ p_no_charter: true });
    });

    it.each([
      ['a charter answered without a charter echo (a server before 0382)', CH_A, null],
      ['a charter answered for another charter', CH_A, echoOf({ ...ALDER, id: CH_B })],
      ['a charter answered as No charter', CH_A, echoOf(null, true)],
      ['No charter answered as All charters', 'none', ECHO_ALL],
      ['All charters answered for a charter', 'all', echoOf(ALDER)],
    ] as const)('%s is an internal error, never figures', async (_l, charter, echo) => {
      const { svc } = service({ [key]: { data: answerOf(filtersOf(echo)), error: null } });
      await expect(call(svc, { ...ALL, charter })).rejects.toMatchObject({
        code: 'internal_error',
      });
      expect(vi.mocked(reportError).mock.calls.at(-1)![1].extra).toEqual({
        check: 'charter_echo',
      });
    });

    it('a refused charter is one validation error, whatever the cause', async () => {
      const refusal = { code: '22023', hint: 'invalid_charter', message: 'invalid charter' };
      const { svc } = service({ [key]: { data: null, error: refusal } });
      await expect(call(svc, CHARTER)).rejects.toMatchObject({
        code: 'validation_error',
        message: BOOK_REPORT_INVALID_CHARTER,
        details: { reason: 'invalid_charter' },
      });
    });
  });

  it('invalid_charter maps to one message and names nothing, whatever the database said', () => {
    const errs = [
      { code: '22023', hint: 'invalid_charter', message: 'invalid charter' },
      { code: '22023', hint: 'invalid_charter', message: 'invalid charter', details: 'x' },
      { code: '22023', hint: 'invalid_charter', message: 'Charter Birch is not yours' },
    ];
    const mapped = errs.map((e) => mapBookReportRpcError(e, 'test'));
    for (const e of mapped) {
      expect(e.code).toBe('validation_error');
      expect(e.message).toBe('That charter is not one you can see.');
      expect(e.details).toEqual({ reason: 'invalid_charter' });
      expect(e.message).not.toMatch(/Birch/);
    }
  });

  it('options carry the charters and whether No charter applies', async () => {
    const { svc } = service({
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [],
          categories: [],
          uncategorized: false,
          charters: [ALDER, { id: CH_B, name: 'Charter Birch', code: null, status: 'archived' }],
          noCharter: true,
          orderStatusConfig: null,
        },
        error: null,
      },
    });
    const res = await svc.options();
    expect(res.charters).toEqual([
      ALDER,
      { id: CH_B, name: 'Charter Birch', code: null, status: 'archived' },
    ]);
    expect(res.noCharter).toBe(true);
  });

  it('options from a server before 0382: no charters, no No charter', async () => {
    const { svc } = service({
      'rpc:book_order_totals_options': {
        data: {
          v: 1,
          warehouses: [],
          categories: [],
          uncategorized: false,
          orderStatusConfig: null,
        },
        error: null,
      },
    });
    const res = await svc.options();
    expect(res.charters).toEqual([]);
    expect(res.noCharter).toBe(false);
  });

  it('a charter answer keeps its echo and its by-charter value on the page', async () => {
    const { svc } = service({
      'rpc:book_order_totals': {
        data: totalsAnswer([row(ITEM_A, '30')], {
          filters: { warehouse: null, category: null, uncategorized: false, ...ECHO_ALL },
          byCharter: [
            { ...ALDER, copies: '30', orders: 2 },
            { id: null, name: null, code: null, status: null, copies: '4', orders: 1 },
          ],
        }),
        error: null,
      },
    });
    const res = await svc.page(ALL, ALL_W);
    expect(res.filters).toMatchObject(ECHO_ALL);
    expect(res.byCharter).toHaveLength(2);
    expect(res.byCharter![1]!.id).toBeNull();
  });
});
