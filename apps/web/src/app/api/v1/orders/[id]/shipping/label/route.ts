import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
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
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.shipping.label' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
