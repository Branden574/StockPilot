import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { reportError } from '@/lib/error-reporter';
import { CycleCountSheetPdf, type CycleCountPdfLine } from '@/lib/pdf/cycle-count';
import { audit } from '@/server/services/audit';
import { assertPermission, ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
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

    // Pull bin / primary-location labels for each item in one shot so the
    // counter knows where to physically look. Items can be missing a
    // bin_location, so render '—' in that slot. inventory_items already
    // belongs to the same org via RLS.
    const itemIds = lines
      .map((l) => l.item_id)
      .filter((v): v is string => Boolean(v));
    const binByItem = new Map<string, string | null>();
    if (itemIds.length > 0) {
      const { data } = await ctx.supabase
        .from('inventory_items')
        .select('id, bin_location, primary_location_id, locations:locations!primary_location_id (name)')
        .eq('organization_id', ctx.organizationId)
        .in('id', itemIds);
      for (const row of (data ?? []) as Array<{
        id: string;
        bin_location: string | null;
        locations: { name: string } | { name: string }[] | null;
      }>) {
        const locField = row.locations;
        const loc = Array.isArray(locField) ? locField[0] : locField;
        const label = row.bin_location || loc?.name || null;
        binByItem.set(row.id, label);
      }
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
