import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
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
    const imageUrlByItemId = await new ItemImagesService(ctx).primaryImagesForItems(itemIds);

    const pdf = await renderCustomerPackingSlipPdf({
      detail,
      warehouse,
      charterName,
      imageUrlByItemId,
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
