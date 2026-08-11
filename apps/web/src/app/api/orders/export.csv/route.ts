import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { csvFilename, toCsv } from '@/lib/csv';
import { reportError } from '@/lib/error-reporter';
import {
  ORDER_EXPORT_HEADERS,
  ORDER_EXPORT_ROW_CAP,
  orderExportCells,
  parseOrderExportIso,
  resolveOrderExportStatusFilter,
} from '@/lib/orders/export';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The status-tab mapping, accepted-status set, column list and per-row cell
// formatting are shared with the PDF sibling route (export.pdf) via
// lib/orders/export.ts — one definition, two renderings.

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

    const status = resolveOrderExportStatusFilter(params.get('status'));
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
      since: parseOrderExportIso(params.get('since')),
      until: parseOrderExportIso(params.get('until')),
      cap: ORDER_EXPORT_ROW_CAP,
    });

    const csvRows = rows.map((r) => orderExportCells(r));

    let body = toCsv([...ORDER_EXPORT_HEADERS], csvRows);
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
