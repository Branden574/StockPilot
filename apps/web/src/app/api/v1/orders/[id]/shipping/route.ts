import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
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
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;

  try {
    const shipment = await ShippingService.forApiContext(ctx).getShipment(id);
    return NextResponse.json({ shipment });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.shipping.get' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
