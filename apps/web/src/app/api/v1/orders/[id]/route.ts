import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The order fields this route returns, and no others (migration 0389). It
 * used to return the whole row (`select('*')`) to any bearer member: the
 * signature token (the hand-over credential), the return and track tokens,
 * the customer's signature image and email, and the internal notes. Every
 * phone bundle reads only `lines` (digital-pick.tsx since 0b8db084); the
 * phone's type names id, status, assigned_picker_id and picking_claimed_at.
 */
const ORDER_DETAIL_FIELDS = [
  'id',
  'status',
  'order_number',
  'warehouse_id',
  'fulfillment_type',
  'assigned_picker_id',
  'picking_claimed_at',
  'picking_claimed_by',
] as const;

function allowListedOrder(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ORDER_DETAIL_FIELDS) out[key] = row[key] ?? null;
  return out;
}

/**
 * Order detail for the mobile app — the REST parity for the web order page's
 * server load. Returns an allow-listed order header (ORDER_DETAIL_FIELDS) AND
 * its per-line items (with quantity_requested / quantity_picked /
 * quantity_fulfilled and the embedded item), which the native digital-pick
 * screen needs. Auth via withApiContext (Bearer); the service's get() is
 * org-scoped + RLS-guarded, so a caller only ever sees their own org's order.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  try {
    const detail = await new OrderRequestsService(ctx).get(id);
    return NextResponse.json({
      order: allowListedOrder(detail.request as unknown as Record<string, unknown>),
      lines: detail.lines,
      warehouseName: detail.warehouseName,
      requesterName: detail.requesterName,
      requesterEmail: detail.requesterEmail,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.get' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
