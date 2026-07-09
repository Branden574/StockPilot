import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { csvFilename, toCsv } from '@/lib/csv';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import {
  OrderRequestsService,
  type OrderRequestStatus,
} from '@/server/services/order-requests';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROW_CAP = 10_000;

// Mirror of the orders list page's status tabs → status-set mapping so an
// "Export" button on the list exports exactly the tab the user is viewing.
// Kept here (not imported from the page) because the page is a server
// component with a lot of unrelated render code; the small duplication is
// cheaper than coupling the route to the page module.
const STATUS_TABS: Record<string, OrderRequestStatus | OrderRequestStatus[]> = {
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

// Statuses an explicit ?status=<status> param may select. Deliberately
// EXCLUDES 'pending_confirmation': those are public-submit limbo rows the
// on-screen orders list never shows (list()/exportRows() only surface them
// when a caller opts in, and the orders page UI cannot select that status
// at all — isStatusTab rejects it). Keeping the export's accepted-status
// set aligned with what the list can show prevents a manager from
// exporting limbo rows that never appear on screen.
const EXPORTABLE_STATUSES = new Set<OrderRequestStatus>([
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

const HEADERS = [
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

/** Accept either a known tab key, an explicit status, or fall through to undefined. */
function resolveStatusFilter(
  raw: string | null,
): OrderRequestStatus | OrderRequestStatus[] | undefined {
  if (!raw) return undefined;
  if (raw in STATUS_TABS) return STATUS_TABS[raw];
  if (EXPORTABLE_STATUSES.has(raw as OrderRequestStatus)) return raw as OrderRequestStatus;
  return undefined;
}

/** Validate an ISO date param; ignore garbage rather than 400 the export. */
function parseIso(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Exporting the org-wide order history is a manager+ operation — the
    // same permission that lets the orders list show every org order
    // (requesters without it only see their own requests). Org-scope is
    // additionally enforced inside the service via the RLS-bound client +
    // explicit organization_id filter.
    if (!can(ctx, 'orders:approve')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const params = new URL(request.url).searchParams;

    const status = resolveStatusFilter(params.get('status'));
    const rawFulfillment = params.get('fulfillment_type');
    const fulfillmentType =
      rawFulfillment === 'pickup' || rawFulfillment === 'delivery'
        ? rawFulfillment
        : undefined;
    const deliveryCharterId = params.get('charter') || undefined;

    const { rows, total } = await new OrderRequestsService(ctx).exportRows({
      status,
      fulfillmentType,
      deliveryCharterId,
      since: parseIso(params.get('since')),
      until: parseIso(params.get('until')),
      cap: ROW_CAP,
    });

    const csvRows = rows.map((r) => ({
      // Short, stable order number derived from the UUID — the order detail
      // page + emails refer to orders this way; full UUID would bloat the CSV.
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
    }));

    let body = toCsv([...HEADERS], csvRows);
    // Base the sentinel on what was ACTUALLY returned, not the intended
    // ROW_CAP. exportRows() now paginates past the 1000-row Data-API cap,
    // so rows.length reaches min(total, ROW_CAP); when total still exceeds
    // it, rows 1..rows.length are present and the rest are omitted. Report
    // the real returned count so the footer can't claim completeness it
    // doesn't have.
    if (total > rows.length) {
      body += `\n# truncated: exported ${rows.length} of ${total} rows`;
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename('orders')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // module_disabled / forbidden surface their own status; everything
      // else is a clean 500 with a stable code.
      const status =
        e.code === 'module_disabled' || e.code === 'forbidden'
          ? 403
          : e.code === 'validation_error'
            ? 400
            : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, { tag: 'orders.export-csv' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
