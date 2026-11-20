import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { invalidPathIdResponse } from '@/server/lib/path-id';
import { serviceErrorResponse } from '@/server/lib/service-error-response';
import { ShippingService } from '@/server/services/shipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Buy-label endpoint. Thin wrapper over ShippingService.buyLabel — buys real
 * postage for the explicitly-confirmed rate. The service gates on `shipping`
 * enabled + `shipping:manage` and is idempotent (a `purchased` row blocks a
 * re-buy), so a retry never double-charges. Maps ServiceError codes to HTTP via
 * the shared `serviceErrorStatus` mapper.
 *
 * Body: { rateId } — the EasyPost rate id to buy. Missing/blank is a
 * request-shape error (400) caught before the service is touched.
 */
const bodySchema = z.object({
  rateId: z.string().min(1),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;
  // A malformed id is a 400 before anything is read with it (B63).
  const invalidId = invalidPathIdResponse(id, 'That order id is not valid.');
  if (invalidId) return invalidId;

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'rateId is required' },
      { status: 400 },
    );
  }

  try {
    const shipment = await ShippingService.forApiContext(ctx).buyLabel(id, parsed.data.rateId);
    return NextResponse.json({ shipment });
  } catch (e) {
    return serviceErrorResponse(e, 'api.v1.orders.shipping.label');
  }
}
