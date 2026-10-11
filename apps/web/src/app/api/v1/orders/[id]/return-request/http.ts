import { NextResponse, type NextRequest } from 'next/server';

import { RETURN_ERROR_WORDS } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { isModuleEnabled, type ServiceContext } from '@/server/services/context';

import { contextFailedResponse, NO_STORE, RATE_LIMITED_MESSAGE } from '../../../returns/http';

/**
 * The member requester routes' shared gate (returns RX-3): a member asking
 * for a return or an exchange on their OWN order, from the phone (Bearer) or
 * the web (cookie).
 *
 *   1. Signed in, an accepted member, an enabled account: withApiContext
 *      answers null otherwise, and a disabled account gets the same 401 as
 *      anyone signed out.
 *   2. Per-user limits: reads 120 an hour, writes 30 an hour (fail-closed).
 *   3. The order id is a uuid, else the one 404 (the service then decides
 *      "own order": requester_user_id = the caller, in the caller's
 *      organization, never a B2B portal order; anything else is the same 404,
 *      so another member's order is not told apart from a missing one).
 *   4. The returns module is on (403 module_disabled otherwise).
 *
 * No permission beyond membership is asked: the order's own requester is the
 * one person these routes serve, as the token their emails carry does.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ONE_HOUR_MS = 60 * 60 * 1000;
export const MEMBER_READS_PER_HOUR = 120;
export const MEMBER_WRITES_PER_HOUR = 30;

/** The one answer for a missing, foreign or unreturnable order. */
export function orderNotAvailable(): NextResponse {
  return NextResponse.json(
    { error: 'not_found', message: RETURN_ERROR_WORDS.orderNotFound },
    { status: 404, headers: NO_STORE },
  );
}

export async function memberRequesterGate(
  req: NextRequest,
  params: Promise<{ id: string }>,
  kind: 'read' | 'write',
): Promise<{ ctx: ServiceContext; orderId: string } | { response: NextResponse }> {
  // An account whose status cannot be read makes withApiContext throw (it
  // fails closed): the route's own 500 shape, no-store (RX-3 fix round 1).
  let ctx: ServiceContext | null;
  try {
    ctx = await withApiContext(req);
  } catch (e) {
    return { response: contextFailedResponse(e, 'returns.member.context') };
  }
  if (!ctx) {
    return {
      response: NextResponse.json(
        { error: 'unauthenticated', message: RETURN_ERROR_WORDS.unauthenticated },
        { status: 401, headers: NO_STORE },
      ),
    };
  }
  const limit = kind === 'read' ? MEMBER_READS_PER_HOUR : MEMBER_WRITES_PER_HOUR;
  const rl = await checkRateLimit(`return-request-${kind}:${ctx.userId}`, limit, ONE_HOUR_MS, 'closed');
  if (!rl.allowed) {
    return {
      response: NextResponse.json(
        { error: 'rate_limited', message: RATE_LIMITED_MESSAGE },
        {
          status: 429,
          headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) },
        },
      ),
    };
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return { response: orderNotAvailable() };
  if (!isModuleEnabled(ctx, 'returns')) {
    return {
      response: NextResponse.json(
        { error: 'module_disabled', message: RETURN_ERROR_WORDS.moduleDisabled },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  return { ctx, orderId: id.toLowerCase() };
}
