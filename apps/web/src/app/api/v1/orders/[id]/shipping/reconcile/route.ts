import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { ShippingService } from '@/server/services/shipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stuck-shipment recovery endpoint. Thin wrapper over
 * ShippingService.reconcilePurchasing — reconciles a row stranded in
 * 'purchasing' (a crash/timeout between the buy claim and the finalize) against
 * EasyPost: if the carrier shows a purchased label it finalizes the row to
 * 'purchased'; otherwise it resets the row to 'draft' so the order can be
 * re-bought. Without this, the 0150 partial unique index permanently blocks
 * every future buy for the order.
 *
 * The service gates on `shipping` enabled + `shipping:manage` (owner/admin only)
 * and NEVER re-buys — it only reads the EasyPost shipment and copies an
 * already-charged label or reopens a row that definitively never got one. Maps
 * ServiceError codes to HTTP via the shared `serviceErrorStatus` mapper.
 *
 * Returns { shipment } — the reconciled row, or null when the stranded row was
 * reset to 'draft' (no completed purchase to surface).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;

  try {
    const shipment = await ShippingService.forApiContext(ctx).reconcilePurchasing(id);
    return NextResponse.json({ shipment });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.shipping.reconcile' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
