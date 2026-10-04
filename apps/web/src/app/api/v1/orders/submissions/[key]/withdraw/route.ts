import type { NextRequest } from 'next/server';

import { ORDER_BODY_UNREADABLE_COPY } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  readPlacerParam,
  submissionError,
  submissionJson,
  submissionRateLimited,
  submissionRefusal,
  submissionUnauthenticated,
} from '@/server/lib/order-submission-http';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Don't send it" (phone ordering PO-2; withdraw_order_submission, 0391):
 * settle the caller's own submission key for good. It takes the same lock a
 * placement takes, so its answer is final:
 *
 * 200 { organizationId, outcome: 'withdrawn' }                the key can never place
 * 200 { organizationId, outcome: 'placed', order }            it had already been placed
 * 200 { organizationId, outcome: 'refused', refusal }         its refusal was recorded
 *
 * Sent only on a tap, never on its own. Membership only (no module,
 * permission or MFA gate). 409 busy (retryable) while a placement under the
 * same key is still running. Rate limit order-submission:<user>, 60 a minute.
 *
 * Body (optional): `{ placerUserId }`, the phone's pending record's placer.
 * When it names another account the answer is 403 placer_mismatch before the
 * function runs, never settled (review round 1). The organization is the
 * X-Organization-Id the call is sent with.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return submissionUnauthenticated();

  const rl = await checkRateLimit(`order-submission:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) return submissionRateLimited(rl.resetAt, ctx.organizationId);

  const { key } = await params;
  if (!KEY_RE.test(key)) {
    return submissionRefusal(
      ctx.organizationId,
      400,
      'validation_error',
      ORDER_BODY_UNREADABLE_COPY,
      {
        reason: 'invalid',
        field: 'idempotencyKey',
      },
    );
  }
  const text = await req.text().catch(() => '');
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return submissionRefusal(ctx.organizationId, 400, 'validation_error', ORDER_BODY_UNREADABLE_COPY, {
      reason: 'invalid',
      field: 'body',
    });
  }
  const placer = readPlacerParam((raw as { placerUserId?: unknown }).placerUserId);
  if (!placer.ok) {
    return submissionRefusal(ctx.organizationId, 400, 'validation_error', ORDER_BODY_UNREADABLE_COPY, {
      reason: 'invalid',
      field: 'placerUserId',
    });
  }
  try {
    return submissionJson(
      await new OrderRequestsService(ctx).withdrawSubmission(key, 'app', {
        placerUserId: placer.placerUserId,
      }),
    );
  } catch (e) {
    return submissionError(e, ctx.organizationId, 'api.v1.orders.submission_withdraw');
  }
}
