import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { NEEDED_BY_FAILED_COPY } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Change an open order's needed-by date (F2-4), the REST twin of the web's
 * reviseOrderNeededByAction, for the phone (Bearer) and the web (cookie). The
 * same service: the orders module, orders:approve, write access to the
 * order's warehouse, and revise_order_needed_by (0382), which repeats every
 * gate, refuses a closed order, a time not in the future and a stale edit, and
 * moves the order's Schedule entry with it (reminders armed again). Nothing is
 * emailed or notified.
 *
 * Body: {
 *   neededByLocal: "YYYY-MM-DDTHH:mm", a wall clock in the ORGANIZATION's zone
 *     (the phone never converts it with the device's zone; the server does,
 *     strictly: a time that does not exist there is refused);
 *   expectedNeededBy: the needed-by the screen showed, as read (ISO), or null;
 *   reason: 1 to 500 characters after trimming.
 * }
 *
 * 200 { revision: { changed, previous, neededBy, eventId, eventUpdated, status,
 *                   schedule, timeZone } }
 * Refusals: { error, message, details: { reason, ... } } with core's words:
 *   400 validation_error (reason_required, needed_by_in_past, invalid_time);
 *   401 unauthenticated; 403 forbidden or module_disabled; 404 not_found;
 *   409 conflict: needed_by_changed (details.current, ISO or null: someone
 *       saved another date first; load it and say so), order_closed
 *       (details.status), busy (details.retryable: the order was locked by
 *       another change for 5 s; try again), timezone_unreadable (retryable);
 *   429 rate_limited; 500 internal_error (core's "couldn't be changed").
 */
const bodySchema = z.object({
  neededByLocal: z.string().trim().min(1).max(40),
  expectedNeededBy: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().max(5000),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // A person changes a date a few times a minute at most; this stops a loop.
  const rl = await checkRateLimit(`order-needed-by:${ctx.userId}`, 30, 60_000);
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
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'validation_error', message: 'Invalid order id' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }

  try {
    const revision = await new OrderRequestsService(ctx).reviseNeededBy({
      id,
      neededByLocal: parsed.data.neededByLocal,
      expectedNeededBy: parsed.data.expectedNeededBy,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ revision });
  } catch (e) {
    if (e instanceof ServiceError) {
      // A fault is core's sentence (the service reported its cause).
      const message = e.code === 'internal_error' ? NEEDED_BY_FAILED_COPY : e.message;
      return NextResponse.json(
        { error: e.code, message, ...(e.details ? { details: e.details } : {}) },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.needed_by' });
    return NextResponse.json(
      { error: 'internal_error', message: NEEDED_BY_FAILED_COPY, details: { reason: 'failed' } },
      { status: 500 },
    );
  }
}
