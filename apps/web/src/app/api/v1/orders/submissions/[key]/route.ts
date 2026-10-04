import type { NextRequest } from 'next/server';

import { ORDER_BODY_UNREADABLE_COPY } from '@stockpilot/core';

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

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What happened to the caller's own order submission key (phone ordering
 * PO-2; order_submission_status, 0391). A read with no lock, run on its own
 * (app foreground, opening the storefront, reconnect):
 *
 * 200 { organizationId, outcome: 'none' | 'placed' | 'refused' | 'withdrawn',
 *       order?, refusal?: { reason, detail } }
 *
 * `none` means ONLY that nothing has committed under the key yet; it never
 * means "nothing was placed" and never unlocks a cart (only the withdraw
 * settles an unknown send). Membership only: no module, permission or MFA
 * gate, so a person whose module or permission was removed can still find out
 * what happened. Rate limit order-submission:<user>, 60 a minute.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
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
  try {
    return submissionJson(await new OrderRequestsService(ctx).submissionStatus(key));
  } catch (e) {
    return submissionError(e, ctx.organizationId, 'api.v1.orders.submission_status');
  }
}
