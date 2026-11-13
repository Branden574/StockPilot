import { NextResponse, type NextRequest } from 'next/server';

import { loadReturnRequestEmailForOrder } from '@/server/services/return-request-email';

import { NO_STORE, returnsErrorResponse } from '../../../returns/http';
import { memberRequesterGate, orderNotAvailable } from '../return-request/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/orders/[id]/return-request-email (F14, the phone's order
 * screen). What the requester of an order needs to open a return request
 * draft about one of their own requests on it:
 *
 *   200 { recipients: { to, cc, toName?, ccName? } | null,
 *         order: { orderNumber, requestedBy, requesterEmail, site,
 *                  warehouseName, link } }
 *
 * `recipients` is the organization's saved delivery-request mailboxes, or
 * null when they are not set or invalid (the phone then shows no section).
 *
 * The gate is the member requester routes' own (../return-request/http.ts):
 * signed in (401), per-user read limit (429), a uuid, the returns module
 * (403). The order must be the caller's own, in their organization: anything
 * else is the same 404, so another member's order is not told apart from a
 * missing one. A separate route from GET .../return-request on purpose: that
 * payload is the requester sheet, which core's forbiddenRequesterKeys keeps
 * free of emails, warehouses and sites because the public return link serves
 * it too; this one is for a signed-in member only.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await memberRequesterGate(req, params, 'read');
  if ('response' in gate) return gate.response;
  const { ctx, orderId } = gate;
  try {
    const answer = await loadReturnRequestEmailForOrder(ctx, orderId);
    if (!answer) return orderNotAvailable();
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.orders.return_request_email.get', ctx);
  }
}
