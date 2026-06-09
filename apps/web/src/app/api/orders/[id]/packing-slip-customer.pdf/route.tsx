import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { getCachedOrgTimezone } from '@/lib/dashboard/cached-org';
import { prefetchImagesAsDataUris } from '@/lib/pdf/image-prefetch';
import { renderCustomerPackingSlipPdf } from '@/lib/pdf/packing-slip-customer';
import type { WarehouseInfo } from '@/lib/pdf/packing-slip-shared';
import { ItemImagesService } from '@/server/services/item-images';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISIBLE_STATUSES = [
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'in_transit',
  'completed',
];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await withApiContext(req);
  const limited = ctx && (await exportRateLimited(ctx.userId));
  if (limited) return limited;
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

    // Warehouse address + contact powers the FROM block and the
    // footer contact card. Charter name handles the SHIP TO label
    // when the order is a delivery.
    const [whRes, charterRes] = await Promise.all([
      ctx.supabase
        .from('warehouses')
        .select('name, code, address, contact_name, contact_email, contact_phone')
        .eq('id', detail.request.warehouse_id)
        .maybeSingle(),
      detail.request.delivery_charter_id
        ? ctx.supabase
            .from('charters')
            .select('name')
            .eq('id', detail.request.delivery_charter_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const wh = (whRes.data ?? null) as
      | {
          name?: string;
          code?: string;
          address?: WarehouseInfo['address'];
          contact_name?: string;
          contact_email?: string;
          contact_phone?: string;
        }
      | null;
    const warehouse: WarehouseInfo = {
      name: wh?.name ?? null,
      code: wh?.code ?? null,
      address: wh?.address ?? null,
      contactName: wh?.contact_name ?? null,
      contactEmail: wh?.contact_email ?? null,
      contactPhone: wh?.contact_phone ?? null,
    };
    const charterName = ((charterRes.data ?? null) as { name?: string } | null)?.name ?? null;

    const itemIds = detail.lines
      .map((l) => l.item?.id)
      .filter((x): x is string => typeof x === 'string');
    if (detail.lines.length >= 100) {
      // eslint-disable-next-line no-console
      console.warn(
        '[packing-slip-customer] large order',
        JSON.stringify({
          tag: 'pdf.large_order',
          orderId: detail.request.id,
          lineCount: detail.lines.length,
          imageCount: itemIds.length,
          organizationId: ctx.organizationId,
        }),
      );
    }
    // PDF image pipeline — small signed URLs → prefetch to base64
    // data URIs. @react-pdf can't reliably fetch URLs at render time
    // in a serverless function, so we pre-resolve them.
    const urlByItem = await new ItemImagesService(ctx).primaryImagesForPdfRendering(
      itemIds,
      200,
    );
    const dataUriByItem = await prefetchImagesAsDataUris(urlByItem.entries());
    const imageUrlByItemId = new Map<string, string>();
    for (const [itemId, dataUri] of dataUriByItem) {
      if (dataUri) imageUrlByItemId.set(itemId, dataUri);
    }

    const orgTimezone = await getCachedOrgTimezone(ctx.organizationId);
    const pdf = await renderCustomerPackingSlipPdf({
      detail,
      warehouse,
      charterName,
      imageUrlByItemId,
      orgTimezone,
    });
    const bytes = new Uint8Array(pdf);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="packing-slip-${detail.request.id.slice(0, 8)}.pdf"`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'internal_error', message: e instanceof Error ? e.message : 'pdf failed' },
      { status: 500 },
    );
  }
}
