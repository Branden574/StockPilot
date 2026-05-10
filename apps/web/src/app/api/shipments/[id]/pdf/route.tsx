import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import {
  ShipmentPdf,
  addressJsonToLines,
  type ShipmentPdfLine,
} from '@/lib/pdf/shipment';
import { audit } from '@/server/services/audit';
import { ServiceError } from '@/server/services/context';
import { ShipmentsService } from '@/server/services/shipments';

// @react-pdf/renderer needs Node APIs (Buffer, fs-style streams) — Edge runtime
// is a non-starter and dynamic = force-dynamic prevents Vercel from trying to
// pre-render the route at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const ctx = await withApiContext(req);
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    const svc = new ShipmentsService(ctx);
    const detail = await svc.get(id);

    const lineRows: ShipmentPdfLine[] = detail.lines.map((l) => ({
      isbn: l.item?.barcode ?? l.item?.sku ?? '',
      description: l.item?.name ?? 'Unknown item',
      qtyShipped: l.qtyShipped,
      qtyBackOrdered: l.qtyBackOrdered,
    }));

    const sourceAddrLines = addressJsonToLines(detail.source?.address ?? null);
    const destAddrLines = addressJsonToLines(detail.destination?.address ?? null);

    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    const stream = await renderToStream(
      <ShipmentPdf
        org={{ name: orgName, logoUrl: orgLogoUrl }}
        shipment={{
          workOrderNumber: detail.workOrderNumber,
          shipDate: detail.shipDate,
          attentionToName: detail.attentionToName,
          notes: detail.notes,
        }}
        source={{
          name: detail.source?.name ?? '',
          addressLines: sourceAddrLines,
          contactPhone: detail.source?.contactPhone ?? null,
          contactEmail: detail.source?.contactEmail ?? null,
        }}
        destination={{
          name: detail.destination?.name ?? '',
          addressLines: destAddrLines,
          contactPhone: detail.destination?.contactPhone ?? null,
          contactEmail: detail.destination?.contactEmail ?? null,
        }}
        lines={lineRows}
        manager={
          detail.source?.manager
            ? {
                fullName: detail.source.manager.fullName,
                role: detail.source.manager.role,
                warehouseAddressLines: sourceAddrLines,
                phone: detail.source.contactPhone,
                email: detail.source.manager.email ?? detail.source.contactEmail,
              }
            : null
        }
      />,
    );

    void audit({
      event: 'pdf.exported',
      entityType: 'shipment',
      entityId: id,
      extra: { format: 'pdf', workOrderNumber: detail.workOrderNumber },
    });

    const filename = `packing-slip-${detail.workOrderNumber}.pdf`;
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
      const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    void reportError(e, { tag: 'pdf.shipment' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
