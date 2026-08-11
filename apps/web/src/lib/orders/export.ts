import type {
  OrderExportRow,
  OrderRequestStatus,
} from '@/server/services/order-requests';

/**
 * Shared vocabulary of the TWO order-history export routes
 * (GET /api/orders/export.csv and GET /api/orders/export.pdf).
 *
 * The PDF route is the CSV route's exact sibling — same permission gate, same
 * status semantics, same rows, only the rendering differs — so the status
 * mapping, the accepted-status set, the column list and the per-row cell
 * formatting live HERE, imported by both. A new order status therefore only
 * needs to join the page's TAB_FILTERS and this module once to reach both
 * export formats.
 */

/** Both export routes cap at the same row count. */
export const ORDER_EXPORT_ROW_CAP = 10_000;

/** The orders list page's status tabs. THE single source: the page imports
 *  these maps (page ← lib is the legal direction; routes must not import
 *  page modules), so a new status/tab joins the vocabulary exactly once to
 *  reach the page tabs AND both export formats. */
export type OrderStatusTab =
  | 'all_active'
  | 'needs_approval'
  | 'picking'
  | 'packing'
  | 'staged'
  | 'in_transit'
  | 'backordered'
  | 'completed'
  | 'denied_cancelled';

export function isOrderStatusTab(value: string | undefined): value is OrderStatusTab {
  return value !== undefined && value in ORDER_EXPORT_STATUS_TABS;
}

export const ORDER_EXPORT_STATUS_TABS: Record<
  OrderStatusTab,
  OrderRequestStatus | OrderRequestStatus[]
> = {
  all_active: [
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
  ],
  needs_approval: 'pending_approval',
  picking: ['pick_slip_generated', 'picking_in_progress', 'picking_complete'],
  packing: 'packing_slip_generated',
  staged: ['staged_for_pickup', 'staged_for_delivery'],
  in_transit: 'in_transit',
  backordered: 'backordered',
  completed: 'completed',
  denied_cancelled: ['denied', 'cancelled'],
};

/** Human labels per tab key — the page's tab strip and the PDF document
 *  title both read from THIS map. */
export const ORDER_EXPORT_TAB_LABELS: Record<OrderStatusTab, string> = {
  all_active: 'All active',
  needs_approval: 'Needs approval',
  picking: 'Picking',
  packing: 'Packing',
  staged: 'Staged',
  in_transit: 'In transit',
  backordered: 'Backordered',
  completed: 'Completed',
  denied_cancelled: 'Denied/Cancelled',
};

// Statuses an explicit ?status=<status> param may select. Deliberately
// EXCLUDES 'pending_confirmation': those are public-submit limbo rows the
// on-screen orders list never shows (list()/exportRows() only surface them
// when a caller opts in, and the orders page UI cannot select that status
// at all — isStatusTab rejects it). Keeping the export's accepted-status
// set aligned with what the list can show prevents a manager from
// exporting limbo rows that never appear on screen.
export const EXPORTABLE_ORDER_STATUSES = new Set<OrderRequestStatus>([
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
  'denied',
  'cancelled',
]);

/** Column keys, in order. These ARE the CSV header labels, and the PDF table
 *  prints the same strings as its column headings (format parity). */
export const ORDER_EXPORT_HEADERS = [
  'order_number',
  'requester',
  'requester_email',
  'charter_destination',
  'warehouse',
  'status',
  'fulfillment_type',
  'source',
  'line_count',
  'total_quantity',
  'total_cost',
  'created_at',
  'approved_at',
  'completed_at',
] as const;

export type OrderExportHeader = (typeof ORDER_EXPORT_HEADERS)[number];

/** Accept either a known tab key, an explicit status, or fall through to undefined. */
export function resolveOrderExportStatusFilter(
  raw: string | null,
): OrderRequestStatus | OrderRequestStatus[] | undefined {
  if (!raw) return undefined;
  if (isOrderStatusTab(raw)) return ORDER_EXPORT_STATUS_TABS[raw];
  if (EXPORTABLE_ORDER_STATUSES.has(raw as OrderRequestStatus)) {
    return raw as OrderRequestStatus;
  }
  return undefined;
}

/** Validate an ISO date param; ignore garbage rather than 400 the export. */
export function parseOrderExportIso(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * One export row → the cell values both formats print, keyed by column.
 * Extracted verbatim from the CSV route so the PDF cannot drift from it.
 */
export function orderExportCells(
  r: OrderExportRow,
): Record<OrderExportHeader, string | number> {
  return {
    // Short, stable order number derived from the UUID — the order detail
    // page + emails refer to orders this way; full UUID would bloat the export.
    order_number: r.id.slice(0, 8).toUpperCase(),
    requester: r.requesterName ?? r.requesterEmail ?? '(external)',
    requester_email: r.requesterEmail ?? '',
    charter_destination: r.charterLabel ?? r.warehouseName ?? '',
    warehouse: r.warehouseName ?? '',
    status: r.status,
    fulfillment_type: r.fulfillmentType,
    source: r.source,
    line_count: r.lineCount,
    total_quantity: r.totalQuantity,
    total_cost: r.totalCost.toFixed(2),
    created_at: r.createdAt,
    approved_at: r.approvedAt ?? '',
    completed_at: r.completedAt ?? '',
  };
}

/**
 * The human name of the view a ?status= param selects — the PDF title's
 * "<TAB LABEL>". An unknown / absent / unresolvable param means no status
 * filter was applied (the same fall-through resolveOrderExportStatusFilter
 * takes), so the label honestly says the whole history was exported.
 */
export function orderExportViewLabel(raw: string | null): string {
  if (raw && isOrderStatusTab(raw)) return ORDER_EXPORT_TAB_LABELS[raw];
  if (raw && EXPORTABLE_ORDER_STATUSES.has(raw as OrderRequestStatus)) {
    const words = raw.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return 'All orders';
}
