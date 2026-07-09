import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Order detail for the mobile app — the REST parity for the web order page's
 * server load. Returns the order header AND its per-line items (with quantity_
 * requested / quantity_picked / quantity_fulfilled and the embedded item), which
 * the native digital-pick screen needs. Auth via withApiContext (Bearer); the
 * service's get() is org-scoped + RLS-guarded, so a caller only ever sees their
 * own org's order.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  try {
    const detail = await new OrderRequestsService(ctx).get(id);
    return NextResponse.json({
      order: detail.request,
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
