import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_KEY_MAX,
  SHORTFALL_PO_MAX_LINES,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderReadinessService } from '@/server/services/order-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Draft purchase orders for what an order is short (F2-5), the REST twin of
 * the web's draftShortfallPosAction, for the phone (Bearer) and the web
 * (cookie). The same service: the orders and purchase_orders modules, a
 * manager holding purchase_orders:manage, write access to the order's
 * warehouse, then draft_order_shortfall_pos (0385), which repeats every
 * floor, takes the reorder drafts' lock, recomputes what may be drafted and
 * refuses anything above it (never lowers it). One draft per supplier plus
 * one for the items with no supplier, all or nothing. Drafts are not sent;
 * no email and no in-app notification is sent (the organization's configured
 * integrations receive po.created per new draft, as for every draft PO).
 *
 * Body: {
 *   lines: [{ itemId: uuid, quantity: number > 0 }], 1 to 200, one per item;
 *   idempotencyKey: 1 to 200 characters, minted by the screen for this
 *     request and sent again with its retries (core shortfallIdempotencyKey).
 * }
 *
 * 200 { result: { orderId, orderNumber, created: [{ purchaseOrderId, poNumber,
 *                 supplierId, lineCount, units, lines }], replay } }
 *   replay: true answers a repeated key with the first call's result (the same
 *   drafts; nothing was written now).
 * Refusals: { error, message, details: { reason, ... } } with core's words:
 *   400 validation_error (invalid, item_not_draftable with details.items,
 *       line_not_on_order with details.itemId);
 *   401 unauthenticated; 403 forbidden or module_disabled; 404 not_found;
 *   409 conflict: shortfall_changed (details.current: the most that may be
 *       drafted per item now; load it, keep the person's choices, and say
 *       so), idempotency_conflict (mint a new key), not_applicable (picked,
 *       closed or more than 200 lines; details.status), busy
 *       (details.retryable: send the same request and key again);
 *   429 rate_limited; 500 internal_error (core's "couldn't be created").
 */
const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().finite().positive().max(1e10),
      }),
    )
    .min(1)
    .max(SHORTFALL_PO_MAX_LINES),
  idempotencyKey: z.string().trim().min(1).max(SHORTFALL_PO_KEY_MAX),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // A buyer drafts a few times a minute at most; this stops a loop.
  const rl = await checkRateLimit(`order-shortfall-po:${ctx.userId}`, 20, 60_000);
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
      { error: 'validation_error', message: SHORTFALL_PO_INVALID_COPY, details: { reason: 'invalid' } },
      { status: 400 },
    );
  }

  try {
    const result = await new OrderReadinessService(ctx).draftShortfallPos({
      orderId: id,
      lines: parsed.data.lines,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return NextResponse.json({ result });
  } catch (e) {
    if (e instanceof ServiceError) {
      // A fault is core's sentence (the service reported its cause).
      const message = e.code === 'internal_error' ? SHORTFALL_PO_FAILED_COPY : e.message;
      return NextResponse.json(
        {
          error: e.code,
          message,
          details: e.code === 'internal_error' ? { reason: 'failed' } : (e.details ?? {}),
        },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.orders.shortfall_po' });
    return NextResponse.json(
      { error: 'internal_error', message: SHORTFALL_PO_FAILED_COPY, details: { reason: 'failed' } },
      { status: 500 },
    );
  }
}
