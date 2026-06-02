import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { DeliveryTrackingService } from '@/server/services/delivery-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  orderId: z.string().uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  accuracy: z.number().nonnegative().optional(),
});

// Mobile driver location ping. Bearer-auth'd; reuses the web service's gates
// (live_tracking module + assigned-driver + in_transit). Both foreground and
// the background TaskManager task POST here.
export async function POST(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const { orderId, ...point } = parsed.data;
    const svc = new DeliveryTrackingService(ctx);
    await svc.shareLocation(orderId, point);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'not_found' ? 404
        : e.code === 'validation_error' ? 400
        : e.code === 'forbidden' || e.code === 'module_disabled' ? 403
        : 500;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: 'internal_error', message: 'Unexpected error' }, { status: 500 });
  }
}
