import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { exchangeOptionsForMember } from '@/server/services/returns-requester';

import { NO_STORE, returnsErrorResponse } from '../../../../returns/http';
import { memberRequesterGate, orderNotAvailable } from '../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The sizes each returnable line of a member's OWN order may be exchanged
 * for (returns RX-3): loaded once, on the sheet's first "Exchange for another
 * size". POST so the answer is never cached on the way; the body is not read
 * (no item, group, warehouse or quantity input, so no oracle), the order id
 * in the path is the caller's own order or the one 404.
 *
 * POST -> 200 { orderId, exchangesEnabled,
 *               lines: [{ orderRequestLineId, options: [{ itemId, name,
 *               sizeLabel, availability, photo }] }] }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await memberRequesterGate(req, params, 'read');
  if ('response' in gate) return gate.response;
  const { ctx, orderId } = gate;
  try {
    const answer = await exchangeOptionsForMember(createAdminClient(), {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      orderRequestId: orderId,
    });
    if (!answer) return orderNotAvailable();
    return NextResponse.json({ orderId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.orders.return_request.options', ctx);
  }
}
