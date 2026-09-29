import type {
  BookOrderOptionsResponse,
  BookOrderTotalsResponse,
  BookReportRow,
  ResolvedBookReportWarehouse,
} from '@stockpilot/core';

/** Fictional fixture ids and answers for the Book Order Totals web tests
 *  (the brief's Book A and Book B example). */
export const ORG = '0e000000-0000-4000-8000-00000000000a';
export const OTHER_ORG = '0e000000-0000-4000-8000-00000000000b';
export const USER = '0e000000-0000-4000-8000-0000000000e1';
export const W1 = '0e000000-0000-4000-8000-0000000000d1';
export const W2 = '0e000000-0000-4000-8000-0000000000d2';
export const ITEM_A = '0e000000-0000-4000-8000-000000000f01';
export const ITEM_B = '0e000000-0000-4000-8000-000000000f02';
export const O1 = '0e000000-0000-4000-8000-000000000101';
export const O2 = '0e000000-0000-4000-8000-000000000102';
export const O3 = '0e000000-0000-4000-8000-000000000103';
/** Order charters (0382): Charter Alder CH-A, Charter Birch (no code),
 *  Charter Cedar CH-C. */
export const CH_A = '0e000000-0000-4000-8000-0000000000a1';
export const CH_B = '0e000000-0000-4000-8000-0000000000a2';
export const CH_C = '0e000000-0000-4000-8000-0000000000a3';
export const ALDER = { id: CH_A, name: 'Charter Alder', code: 'CH-A', status: 'active' };
export const BIRCH = { id: CH_B, name: 'Charter Birch', code: null, status: 'active' };
export const CEDAR = { id: CH_C, name: 'Charter Cedar', code: 'CH-C', status: 'archived' };

export const DEFAULT_11 = [
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

export function bookRow(itemId: string, over: Partial<BookReportRow> = {}): BookReportRow {
  return {
    itemId,
    name: itemId === ITEM_A ? 'Book A' : itemId === ITEM_B ? 'Book B' : `Book ${itemId.slice(-3)}`,
    sku: itemId === ITEM_A ? 'BK-A' : 'BK-B',
    identifier: itemId === ITEM_A ? '9780140449136' : null,
    binLocation: '12-B',
    unit: 'unit',
    countsAsCopies: true,
    warehouseId: W1,
    warehouseName: 'North',
    itemStatus: 'active',
    deleted: false,
    nowRental: false,
    copies: itemId === ITEM_A ? '30' : '4',
    orders: itemId === ITEM_A ? 3 : 1,
    lines: itemId === ITEM_A ? 3 : 1,
    latestOrderAt: '2026-09-21T03:00:00+00:00',
    latestOrderDate: '2026-09-20',
    fulfilled: '0',
    returned: '0',
    ...over,
  };
}

export function totalsResponse(
  over: Partial<BookOrderTotalsResponse> = {},
  warehouse: ResolvedBookReportWarehouse = { id: null, source: 'all' },
): BookOrderTotalsResponse {
  const rows = over.rows ?? [bookRow(ITEM_A), bookRow(ITEM_B)];
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    range: {
      key: 'all',
      from: null,
      to: null,
      timeZone: 'America/Los_Angeles',
      timeZoneFallback: false,
    },
    statuses: DEFAULT_11,
    filters: {
      warehouse: warehouse.id ? { id: warehouse.id, name: 'North', status: 'active' } : null,
      category: null,
      uncategorized: false,
      charter: null,
      noCharter: false,
    },
    scope: { restricted: false },
    summary: {
      copies: '34',
      entries: rows.length,
      orders: 3,
      lines: 4,
      firstOrderAt: '2026-05-12T17:00:00+00:00',
      lastOrderAt: '2026-09-21T03:00:00+00:00',
      firstOrderDate: '2026-05-12',
      lastOrderDate: '2026-09-20',
      unresolved: { entries: 0, quantity: '0' },
    },
    totalCount: rows.length,
    mode: 'page',
    tooMany: false,
    maxRows: null,
    page: 1,
    pageSize: 25,
    sort: 'copies',
    organizationId: ORG,
    warehouse,
    ...over,
    rows,
  };
}

export function optionsResponse(over: Partial<BookOrderOptionsResponse> = {}): BookOrderOptionsResponse {
  const statusLabels = Object.fromEntries(
    [...DEFAULT_11, 'pending_confirmation', 'denied', 'cancelled'].map((s) => [s, s]),
  ) as BookOrderOptionsResponse['statusLabels'];
  return {
    v: 1,
    organizationId: ORG,
    warehouses: [
      { id: W1, name: 'North', status: 'active' },
      { id: W2, name: 'South', status: 'archived' },
    ],
    categories: [{ id: '0e000000-0000-4000-8000-0000000000c1', name: 'Fiction', deleted: true }],
    uncategorized: true,
    charters: [],
    noCharter: false,
    statusLabels,
    ...over,
  };
}

/** The drill-down API's JSON (rows carry `openable`, never `mine`). */
export function ordersJson(
  over: Record<string, unknown> = {},
  rows: Array<Record<string, unknown>> = [
    orderRow(O3, 3, { openable: true, copies: '5', status: 'pending_approval' }),
    orderRow(O2, 2, { openable: false, copies: '15', lines: 2, lineIds: ['l2a', 'l2b'] }),
    orderRow(O1, 1, { openable: false, copies: '10' }),
  ],
): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    found: true,
    book: {
      itemId: ITEM_A,
      name: 'Book A',
      sku: 'BK-A',
      identifier: '9780140449136',
      binLocation: '12-B',
      unit: 'unit',
      countsAsCopies: true,
      warehouseId: W1,
      warehouseName: 'North',
      itemStatus: 'active',
      deleted: false,
      nowRental: false,
    },
    range: {
      key: 'all',
      from: null,
      to: null,
      timeZone: 'America/Los_Angeles',
      timeZoneFallback: false,
    },
    statuses: DEFAULT_11,
    filters: { warehouse: null, charter: null, noCharter: false },
    totals: { copies: '30', orders: 3, lines: 4, fulfilled: '8', returned: '2' },
    totalCount: rows.length,
    page: 1,
    pageSize: 25,
    organizationId: ORG,
    warehouse: { id: null, source: 'all' },
    rows,
    ...over,
  };
}

export function orderRow(
  orderId: string,
  orderNumber: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    orderNumber,
    createdAt: '2026-09-21T03:00:00+00:00',
    orderDate: '2026-09-20',
    status: 'approved',
    warehouseId: W1,
    warehouseName: 'North',
    copies: '5',
    fulfilled: '0',
    returned: '0',
    lines: 1,
    lineIds: [`line-${orderNumber}`],
    openable: false,
    ...over,
  };
}
