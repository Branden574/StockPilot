import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.coerce.number().positive().max(100_000),
      }),
    )
    .min(1)
    .max(200),
});

/**
 * Add items to an existing order — the Bearer/mobile twin of
 * addOrderRequestLinesAction (web server action). Reuses the SAME gated
 * service method (OrderRequestsService.addLines), so the ship-status gate,
 * requester-or-approver rule, warehouse access, and expected-item guard are
 * enforced identically on both platforms.
 *
 * Body: { lines: [{ itemId: uuid, quantity: number > 0 }] }
 * → 200 { ok: true, added, merged, pickSlipStale }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const rl = await checkRateLimit(`order-add-lines:${ctx.userId}`, 60, 60_000);
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
    const result = await new OrderRequestsService(ctx).addLines(id, parsed.data.lines);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.add_lines' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
