/**
 * Book Order Totals answers as the /api/v1 routes send them, for the phone's
 * tests. The figures are the brief's acceptance example (Book A 30 copies in
 * 3 orders, Book B 4 in 1; 34 copies, 2 entries, 3 orders).
 */

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
export const USER = '33333333-3333-4333-8333-333333333333';
export const W1 = '44444444-4444-4444-8444-444444444444';
export const W2 = '55555555-5555-4555-8555-555555555555';
export const BOOK_A = '66666666-6666-4666-8666-666666666666';
export const BOOK_B = '77777777-7777-4777-8777-777777777777';
export const ORDER_1 = '88888888-8888-4888-8888-888888888888';

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

export const rowA = {
  itemId: BOOK_A,
  name: 'Book A',
  sku: 'BK-A',
  identifier: '9780140449136',
  binLocation: '12-B',
  unit: 'unit',
  countsAsCopies: true,
  warehouseId: W1,
  warehouseName: 'DC4',
  itemStatus: 'active',
  deleted: false,
  nowRental: false,
  copies: '30',
  orders: 3,
  lines: 3,
  latestOrderAt: '2026-09-20T17:00:00+00:00',
  latestOrderDate: '2026-09-20',
  fulfilled: '8',
  returned: '2',
};

export const rowB = {
  ...rowA,
  itemId: BOOK_B,
  name: 'Book B',
  sku: 'BK-B',
  identifier: '9780140449137',
  copies: '4',
  orders: 1,
  lines: 1,
  fulfilled: '0',
  returned: '0',
};

export function totalsAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
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
    filters: { warehouse: null, category: null, uncategorized: false },
    scope: { restricted: false },
    summary: {
      copies: '34',
      entries: 2,
      orders: 3,
      lines: 4,
      firstOrderAt: '2026-05-12T17:00:00+00:00',
      lastOrderAt: '2026-09-20T17:00:00+00:00',
      firstOrderDate: '2026-05-12',
      lastOrderDate: '2026-09-20',
      unresolved: { entries: 0, quantity: '0' },
    },
    totalCount: 2,
    mode: 'page',
    tooMany: false,
    maxRows: null,
    page: 1,
    pageSize: 25,
    sort: 'copies',
    rows: [rowA, rowB],
    organizationId: ORG,
    warehouse: { id: null, source: 'all' },
    ...over,
  };
}

export const orderRow = {
  orderId: ORDER_1,
  orderNumber: 49,
  createdAt: '2026-09-20T17:00:00+00:00',
  orderDate: '2026-09-20',
  status: 'approved',
  warehouseId: W1,
  warehouseName: 'DC4',
  copies: '10',
  fulfilled: '8',
  returned: '2',
  lines: 2,
  lineIds: ['l1', 'l2'],
  openable: false,
};

export function ordersAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-09-28T17:42:00+00:00',
    generatedAtLocal: '2026-09-28 10:42',
    found: true,
    book: {
      itemId: BOOK_A,
      name: 'Book A',
      sku: 'BK-A',
      identifier: '9780140449136',
      binLocation: '12-B',
      unit: 'unit',
      countsAsCopies: true,
      warehouseId: W1,
      warehouseName: 'DC4',
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
    filters: { warehouse: null },
    totals: { copies: '30', orders: 3, lines: 4, fulfilled: '8', returned: '2' },
    totalCount: 3,
    page: 1,
    pageSize: 25,
    rows: [orderRow],
    organizationId: ORG,
    warehouse: { id: null, source: 'all' },
    ...over,
  };
}

export function optionsAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  const statusLabels: Record<string, string> = {};
  for (const s of [
    'pending_confirmation',
    ...DEFAULT_11,
    'denied',
    'cancelled',
  ]) {
    statusLabels[s] = s === 'completed' ? 'Handed over' : s;
  }
  return {
    v: 1,
    organizationId: ORG,
    warehouses: [
      { id: W1, name: 'DC4', status: 'active' },
      { id: W2, name: 'North', status: 'archived' },
    ],
    categories: [{ id: BOOK_B, name: 'Fiction', deleted: true }],
    uncategorized: true,
    statusLabels,
    ...over,
  };
}
