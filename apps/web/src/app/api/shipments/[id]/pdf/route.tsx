import { NextResponse, type NextRequest } from 'next/server';
import { renderToStream } from '@react-pdf/renderer';
import QRCode from 'qrcode';

import { env } from '@/lib/env';
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
    // Destination is a charter — no address field in the schema, so no
    // destination address lines to compute.

    const { data: org } = await ctx.supabase
      .from('organizations')
      .select('name, logo_url')
      .eq('id', ctx.organizationId)
      .maybeSingle();
    const orgName = ((org as { name?: string | null })?.name ?? 'StockPilot') || 'StockPilot';
    const orgLogoUrl = ((org as { logo_url?: string | null })?.logo_url ?? null) || null;

    // QR points at the public /s/[token] signature page. Skip generation
    // when the shipment is already delivered (the PDF renderer also hides
    // it in that case) or when the token is missing for some reason.
    let qrDataUrl: string | null = null;
    const tokenRow = await ctx.supabase
      .from('shipments')
      .select('signature_token')
      .eq('organization_id', ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    const signatureToken =
      ((tokenRow.data as { signature_token?: string | null } | null)
        ?.signature_token ?? null) || null;
    if (
      signatureToken &&
      detail.status !== 'delivered' &&
      detail.status !== 'cancelled'
    ) {
      try {
        qrDataUrl = await QRCode.toDataURL(
          `${env.NEXT_PUBLIC_APP_URL}/s/${signatureToken}`,
          { margin: 0, width: 240, errorCorrectionLevel: 'M' },
        );
      } catch (e) {
        // QR generation failure must not break the PDF — log + render
        // the slip without the QR block.
        void reportError(e, { tag: 'pdf.shipment.qrcode' });
      }
    }

    const stream = await renderToStream(
      <ShipmentPdf
        org={{ name: orgName, logoUrl: orgLogoUrl }}
        shipment={{
          workOrderNumber: detail.workOrderNumber,
          shipDate: detail.shipDate,
          attentionToName: detail.attentionToName,
          notes: detail.notes,
          status: detail.status,
        }}
        source={{
          name: detail.source?.name ?? '',
          addressLines: sourceAddrLines,
          contactPhone: detail.source?.contactPhone ?? null,
          contactEmail: detail.source?.contactEmail ?? null,
        }}
        destination={{
          name: detail.destination?.name ?? '',
          code: detail.destination?.code ?? null,
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
        qrDataUrl={qrDataUrl}
        signature={
          detail.signatureImageUrl && detail.signedAt
            ? {
                imageDataUrl: detail.signatureImageUrl,
                signedByName: detail.signedByName,
                signedAt: detail.signedAt,
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
