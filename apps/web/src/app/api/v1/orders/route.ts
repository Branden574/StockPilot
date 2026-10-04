import type { NextRequest } from 'next/server';

import { parseOrderCreateRequest } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  submissionError,
  submissionJson,
  submissionRateLimited,
  submissionRefusal,
  submissionUnauthenticated,
} from '@/server/lib/order-submission-http';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Place an order request from the phone (phone ordering PO-2): the REST twin
 * of the New order page's createOrderRequestAction, over the same service
 * method (OrderRequestsService.create) and the same database function
 * (place_order_request, 0391). Bearer (the phone) or cookie.
 *
 * Body: core's create body, `.strict()` (orderCreateRequestSchema):
 *   { idempotencyKey, placerUserId, warehouseId, fulfillmentType,
 *     deliveryCharterId, onBehalfOf, notes, neededByLocal, lines, kits? }
 * The key is minted once per submission (core mintOrderSubmissionKey) and
 * sent again, with the SAME body, by every resend; the placer must be the
 * signed-in user; neededByLocal is the organization's wall clock.
 *
 * 201 { organizationId, result: { replay: false, order } }   placed now
 * 200 { organizationId, result: { replay: true,  order } }   the key had placed it
 * Refusals { organizationId?, error, message, details: { reason, ... } }, core's
 * words; `details.settled: true` when the refusal is recorded under the key
 * (final: a resend gets the same answer):
 *   400 validation_error (the body; needed_by_*, site_not_available,
 *       item_not_orderable with details.items, recorded);
 *   401 unauthenticated; 403 forbidden (placer_mismatch, permission,
 *       on_behalf_not_permitted, aal2_required, mfa_required) or
 *       module_disabled; 404 not_found (warehouse_not_available);
 *   409 conflict: busy (details.retryable: send the same body and key again),
 *       idempotency_conflict (details.orderId, orderNumber when placed),
 *       submission_withdrawn (settled), timezone_unreadable (retryable);
 *   429 rate_limited (retry-after); 500 internal_error (core's fault sentence,
 *       details.reason 'failed').
 *
 * Stays up when the phone storefront's kill switch is off (plan 3.1): a
 * pending send must always be settleable.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return submissionUnauthenticated();

  // Production peaks near one order a minute per organization; this stops a
  // loop. The limiter fails open: the key, not the limiter, stops duplicates.
  const rl = await checkRateLimit(`order-create:${ctx.userId}`, 20, 60_000);
  if (!rl.allowed) return submissionRateLimited(rl.resetAt, ctx.organizationId);

  const raw: unknown = await req.json().catch(() => null);
  const parsed = parseOrderCreateRequest(raw);
  if (!parsed.ok) {
    const { reason, field, message } = parsed.refusal;
    return submissionRefusal(ctx.organizationId, 400, 'validation_error', message, {
      reason,
      ...(field ? { field } : {}),
    });
  }

  try {
    const answer = await new OrderRequestsService(ctx).create({ body: raw, surface: 'app' });
    return submissionJson(
      {
        organizationId: answer.organizationId,
        result: { replay: answer.replay, order: answer.order },
      },
      answer.replay ? 200 : 201,
    );
  } catch (e) {
    return submissionError(e, ctx.organizationId, 'api.v1.orders.create');
  }
}
