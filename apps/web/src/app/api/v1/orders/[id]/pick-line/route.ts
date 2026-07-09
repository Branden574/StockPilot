import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Record a per-line picked quantity — the REST parity for the web DigitalPick
 * card's recordPickedLineAction (a server action, web-only). This is what makes
 * native line-by-line digital picking possible on mobile (previously the app
 * could only "mark all complete"). It reuses the SAME gated service method the
 * web uses (OrderRequestsService.recordPickedLine → partial_pick_line RPC), so
 * module/permission (items:update) + warehouse-write + status + over_pick guards
 * are all enforced server-side. It does NOT decrement stock — that happens only
 * at complete_picking (via the transition route) — so no inventory revalidation.
 *
 * Body: { lineId: uuid, quantity: number 0..10000 }
 */
const bodySchema = z.object({
  lineId: z.string().uuid(),
  // Matches the web recordPickedLineSchema. The RPC additionally caps qty at the
  // line's quantity_requested (raises over_pick → 409), so this is just an outer
  // sanity bound.
  quantity: z.coerce.number().min(0).max(10_000),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Picking a large order fires one save per line; 120/min/user comfortably
  // covers a real pick pass while stopping scripted abuse.
  const rl = await checkRateLimit(`order-pick-line:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: { 'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) },
      },
    );
  }

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    await new OrderRequestsService(ctx).recordPickedLine(id, parsed.data.lineId, parsed.data.quantity);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.pick_line' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
