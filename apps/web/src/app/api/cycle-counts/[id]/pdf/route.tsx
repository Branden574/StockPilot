import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { countSheetLocationLabel } from '@/lib/pdf/count-sheet-location';
import { CycleCountSheetPdf, type CycleCountPdfLine } from '@/lib/pdf/cycle-count';
import { audit } from '@/server/services/audit';
import { assertPermission, ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { fetchRackHoldingsByItem } from '@/server/services/rack-holdings';
import { WarehousesService } from '@/server/services/warehouses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const ctx = await withApiContext(req);
    const limited = ctx && (await exportRateLimited(ctx.userId, ctx.organizationId));
    if (limited) return limited;
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    // Cycle-count PDFs reveal counted qtys, variance, and notes that
    // can include WIP context (count notes often record discrepancies
    // before any adjustment is made). Restrict to the same permission
    // that gates the rest of the cycle-count UI so viewers can't pull
    // the report directly via URL. The dashboard page already redirects
    // viewers; this is defense-in-depth against direct API calls.
    assertPermission(ctx, 'stock:adjust');

    const ccSvc = new CycleCountsService(ctx);
    const warehousesSvc = new WarehousesService(ctx);

    const { header, lines } = await ccSvc.get(id);

    let warehouseName: string | null = null;
    if (header.warehouse_id) {
      const warehouses = await warehousesSvc.list();
      warehouseName = warehouses.find((w) => w.id === header.warehouse_id)?.name ?? null;
    }

    // Pull the walk-to label for each item in one shot so the counter knows
    // where to physically look: the structured rack/crate from custom_fields
    // first (books "Rack 39-B · Crate Red 5", items "Rack 38-A"), then the
    // free-text bin_location, then the site name. The site name alone (old
    // behavior) printed "DC4" on every row — useless for finding the stock.
    // inventory_items already belongs to the same org via RLS.
    const itemIds = lines
      .map((l) => l.item_id)
      .filter((v): v is string => Boolean(v));
    const binByItem = new Map<string, string | null>();
    // CHUNKED: get() now returns EVERY line (no 1000-row cap), so a big-warehouse
    // count can carry tens of thousands of item ids. A single `.in('id', ids)`
    // would both build a giant statement AND clamp its RESULT to [api]
    // max_rows = 1000, silently dropping the location hint for every row past
    // #1000. 100 uuids ≈ 3.7KB of query string — comfortably under the
    // 8–16KB gateway/URL rejection threshold (same ID_CHUNK_SIZE rationale as
    // server/loaders/inventory-list.ts; a 1000-id chunk was a ~37KB GET the
    // edge would bounce). Chunks run in PARALLEL, and any chunk error THROWS:
    // a count sheet printing without walk-to locations is a silent
    // correctness failure, so it must surface as the route's 500, never as a
    // quietly location-less printout.
    type LookupRow = {
      id: string;
      item_type: string | null;
      custom_fields: Record<string, unknown> | null;
      bin_location: string | null;
      locations: { name: string } | { name: string }[] | null;
    };
    const LOOKUP_CHUNK = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < itemIds.length; i += LOOKUP_CHUNK) {
      chunks.push(itemIds.slice(i, i + LOOKUP_CHUNK));
    }
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const { data, error } = await ctx.supabase
          .from('inventory_items')
          .select('id, item_type, custom_fields, bin_location, primary_location_id, locations:locations!primary_location_id (name)')
          .eq('organization_id', ctx.organizationId)
          .in('id', chunk);
        if (error) {
          throw new ServiceError(
            'internal_error',
            `Count-sheet location lookup failed: ${error.message}`,
          );
        }
        return (data ?? []) as LookupRow[];
      }),
    );

    // Rack/crate HOLDINGS for every item on the sheet — scoped to the
    // count's warehouse when it has one (a per-warehouse count only ever
    // walks that warehouse); an org-wide count (header.warehouse_id null)
    // passes no scope, so a holding is reported wherever it physically
    // sits. Split items (>1 holding) get the full breakdown instead of a
    // single (possibly stale/misleading) label — see countSheetLocationLabel.
    const rackHoldingsByItemId = await fetchRackHoldingsByItem(
      ctx,
      itemIds,
      header.warehouse_id,
    );

    for (const row of chunkResults.flat()) {
      const locField = row.locations;
      const loc = Array.isArray(locField) ? locField[0] : locField;
      const label = countSheetLocationLabel({
        item_type: row.item_type,
        custom_fields: row.custom_fields,
        bin_location: row.bin_location,
        primaryLocationName: loc?.name ?? null,
        rackHoldings: rackHoldingsByItemId.get(row.id),
      });
      binByItem.set(row.id, label);
    }

    const lineRows: CycleCountPdfLine[] = lines.map((l) => ({
      sku: l.item?.sku ?? '',
      name: l.item?.name ?? 'Unknown item',
      unitOfMeasure: l.item?.unit_of_measure ?? '',
      location: binByItem.get(l.item_id) ?? null,
      expectedQuantity: Number(l.expected_quantity) || 0,
      // Pass counted qty so the PDF can render a variance report when
      // the count is closed. The PDF component decides what to render
      // based on cycle.status.
      countedQuantity:
        l.counted_quantity == null ? null : Number(l.counted_quantity),
    }));

    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const stream = await renderToStream(
      <CycleCountSheetPdf
        cycle={{
          id: header.id,
          warehouseName,
          notes: header.notes ?? null,
          startedAt: header.started_at ?? null,
          status: header.status,
        }}
        lines={lineRows}
        org={{ name: orgName, logoUrl: orgLogoUrl }}
      />,
    );

    // Block on the audit write so a render-then-process-exit (Vercel
    // can terminate the request after the response stream resolves)
    // doesn't drop the log row. audit() is best-effort internally —
    // a slow audit_logs insert can't fail this request.
    await audit(
      {
        event: 'pdf.exported',
        entityType: 'cycle_count',
        entityId: id,
        extra: {
          format: 'pdf',
          // Distinguishes a printed count sheet from a posted variance
          // report in the audit trail. Different artifact, same route.
          variant:
            header.status === 'in_progress' ? 'count_sheet' : 'variance_report',
          line_count: lineRows.length,
        },
      },
      ctx,
    );

    const filename = `cycle-count-${id.slice(0, 8)}.pdf`;
    return new NextResponse(stream as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'not_found'
          ? 404
          : e.code === 'forbidden'
            ? 403
            : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, { tag: 'pdf.cycle_count' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
