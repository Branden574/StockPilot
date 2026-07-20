import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { RMAService } from '@/server/services/returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Create return" — Bearer parity for web's createReturnFromOrderAction.
 * Reuses RMAService.createFromOrder verbatim (returns module gate +
 * returns:manage assert, org-scoped order lookup → not_found for foreign or
 * unknown ids, completed/delivered status gate, durable per-line budget
 * quantity_fulfilled − returned_quantity, item-identity stamping). Body is the
 * SAME zod contract as the web action minus orderRequestId, which comes from
 * the path.
 *
 * → 200 { ok: true, return: ReturnWithLines }
 */
const bodySchema = z.object({
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        orderRequestLineId: z.string().uuid(),
        // Whole units only — fractional return quantities are data-shape
        // nonsense (the DB cap trigger backstops over-return, not shape).
        quantity: z.coerce.number().int().positive(),
        disposition: z.enum(['restock', 'scrap']),
      }),
    )
    .min(1),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's returns
  // module + returns:manage gates. 30/min is far above human tapping while
  // capping a runaway client's write pressure on the returns tables.
  const rl = await checkRateLimit(`orders:returns:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid order id.' },
      { status: 400 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'Request body must be JSON.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  try {
    // Constructed from the Bearer API ctx (NOT forCurrentUser — that path is
    // cookie-session-bound and dead on the Bearer surface).
    const svc = RMAService.forApiContext(ctx);
    const created = await svc.createFromOrder(id, parsed.data);
    return NextResponse.json({ ok: true, return: created });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.returns.create' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
