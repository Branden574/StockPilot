import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { ShippingService } from '@/server/services/shipping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Rate-shop endpoint. Thin wrapper over ShippingService.getRates — creates a
 * (non-billable) EasyPost Shipment and returns the available rates. The service
 * gates on `shipping` enabled + `shipping:manage`; mapping ServiceError codes to
 * HTTP via the shared `serviceErrorStatus` mapper.
 *
 * Body: { parcel: { weight_oz, length_in, width_in, height_in } } — all
 * positive numbers; an invalid parcel is a request-shape error (400) caught
 * before the service is touched.
 */
const bodySchema = z.object({
  parcel: z.object({
    weight_oz: z.number().positive(),
    length_in: z.number().positive(),
    width_in: z.number().positive(),
    height_in: z.number().positive(),
  }),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { id } = await params;

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid parcel' },
      { status: 400 },
    );
  }

  try {
    const result = await ShippingService.forApiContext(ctx).getRates(id, parsed.data.parcel);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.shipping.rates' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
