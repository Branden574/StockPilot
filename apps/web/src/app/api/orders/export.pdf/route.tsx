import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { buildExportFilename } from '@/lib/exports/filename';
import {
  ORDER_EXPORT_ROW_CAP,
  orderExportViewLabel,
  parseOrderExportIso,
  resolveOrderExportStatusFilter,
} from '@/lib/orders/export';
import { buildOrdersExportPdfRows, OrdersExportPdf } from '@/lib/pdf/orders-export-pdf';
import { ServiceError } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { can } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Up to 10k rows rendered in-memory by react-pdf. (api/orders is not under a
// vercel.json functions glob, so set the budget inline — same as the
// inventory export route.)
export const maxDuration = 60;

/**
 * GET /api/orders/export.pdf — the PDF twin of export.csv.
 *
 * EXACT sibling contract: same permission gate (orders:approve), same org
 * scoping, same ?status= tab/status semantics, same row source
 * (OrderRequestsService.exportRows) and the same columns/formatting via
 * lib/orders/export.ts. Only the rendering differs. Zero matching rows still
 * renders a valid one-page document (header + "No order requests in this
 * view.") exactly as the CSV returns its header-only body — never a 500.
 */
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

    const rawStatus = params.get('status');
    const status = resolveOrderExportStatusFilter(rawStatus);
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

    // Same branded-header composition as the inventory export PDF: org name
    // (+ logo when set) on the left, title/subtitle/generated-at on the right.
    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const viewLabel = orderExportViewLabel(rawStatus);
    const pdfRows = buildOrdersExportPdfRows(rows);

    const stream = await renderToStream(
      // eslint-disable-next-line react-hooks/error-boundaries -- RSC + react-pdf renderToStream; rule targets client error boundaries
      <OrdersExportPdf
        orgName={orgName}
        orgLogoUrl={orgLogoUrl}
        title={`Order requests — ${viewLabel}`}
        subtitle={`${rows.length} order${rows.length === 1 ? '' : 's'}${
          total > rows.length ? ` (first ${rows.length} of ${total})` : ''
        }`}
        rows={pdfRows}
        // Same truncation honesty as the CSV's "# truncated" sentinel line.
        footerNote={
          total > rows.length
            ? `Truncated: exported ${rows.length} of ${total} rows`
            : undefined
        }
      />,
    );

    // Filename via the shared builder (the one place preset/tab text is
    // sanitized for Content-Disposition): orders-<status>-<date>.pdf, or
    // orders-<date>.pdf when no status filter was applied.
    const filename = buildExportFilename({
      slug: 'orders',
      scope: 'all',
      format: 'pdf',
      presetName: status ? `orders ${rawStatus}` : 'orders',
    });

    const webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
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
    void reportError(e, { tag: 'orders.export-pdf' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
