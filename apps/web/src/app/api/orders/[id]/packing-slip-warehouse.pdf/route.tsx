import QRCode from 'qrcode';
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { env } from '@/lib/env';
import { renderWarehousePackingSlipPdf } from '@/lib/pdf/packing-slip-warehouse';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISIBLE_STATUSES = [
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'signature_requested',
  'completed',
];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const svc = new OrderRequestsService(ctx);
    const detail = await svc.get(id);
    if (!VISIBLE_STATUSES.includes(detail.request.status)) {
      return NextResponse.json(
        { error: 'not_yet_generated', message: 'Generate packing slips first.' },
        { status: 400 },
      );
    }

    const token = detail.request.signature_token;
    let qrDataUrl: string | null = null;
    if (token) {
      const appUrl = env.NEXT_PUBLIC_APP_URL ?? '';
      const url = `${appUrl}/orders/sign/${token}`;
      try {
        qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
      } catch {
        qrDataUrl = null;
      }
    }

    // Pull charter name when present, for the warehouse-slip header.
    // Reuse the API-context's supabase client so RLS applies cleanly.
    let charterName: string | null = null;
    if (detail.request.delivery_charter_id) {
      const { data } = await ctx.supabase
        .from('charters')
        .select('name')
        .eq('id', detail.request.delivery_charter_id)
        .maybeSingle();
      charterName = (data as { name?: string } | null)?.name ?? null;
    }

    const pdf = await renderWarehousePackingSlipPdf({ detail, qrDataUrl, charterName });
    const bytes = new Uint8Array(pdf);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="packing-slip-warehouse-${detail.request.id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'pdf failed' },
      { status: 500 },
    );
  }
}
