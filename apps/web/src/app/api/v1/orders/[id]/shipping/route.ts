import { NextResponse, type NextRequest } from 'next/server';

import { apiReadContext } from '@/server/lib/api-read-context';
import { invalidPathIdResponse } from '@/server/lib/path-id';
import { serviceErrorResponse } from '@/server/lib/service-error-response';
import { ShippingService } from '@/server/services/shipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read the current carrier shipment for an order. Thin wrapper over
 * ShippingService.getShipment — member-level + module-gated read. Returns
 * { shipment } (the most-recent row, any status) or { shipment: null } when
 * none exists. Maps ServiceError codes to HTTP via the shared
 * `serviceErrorStatus` mapper.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const read = await apiReadContext(req);
  if ('response' in read) return read.response;
  const ctx = read.ctx;
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // A malformed id is a 400 before anything is read with it (B63).
  const invalidId = invalidPathIdResponse(id, 'That order id is not valid.');
  if (invalidId) return invalidId;

  try {
    const shipment = await ShippingService.forApiContext(ctx).getShipment(id);
    return NextResponse.json({ shipment });
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.orders.shipping.get');
  }
}
