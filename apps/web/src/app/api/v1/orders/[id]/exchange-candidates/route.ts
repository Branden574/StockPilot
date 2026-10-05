import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, NO_STORE, returnsContext, returnsErrorResponse } from '../../../returns/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/orders/[id]/exchange-candidates?line=<order line id>&q= — the
 * same replacement search as /api/v1/returns/[id]/candidates, before the
 * RMA exists: the create sheet's "Exchange for another size or item" loads
 * it on the first Exchange (returns RX-2). Staff only (returns:manage).
 *
 * 200 { organizationId, orderId, orderRequestLineId, returnedItemId,
 * groupId, siblings, matches } · 400 · 401 · 403 · 404 · 429.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That order id is not valid.', details: { reason: 'return_invalid' } },
      { status: 400, headers: NO_STORE },
    );
  }
  const gate = await returnsContext(req, 'read');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  const sp = new URL(req.url).searchParams;
  const parsed = parseReturnBody('candidates', { line: sp.get('line') ?? '', q: sp.get('q') });
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const answer = await RMAService.forApiContext(ctx).candidatesForOrder(id, parsed.value);
    return NextResponse.json({ organizationId: ctx.organizationId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.orders.exchange_candidates', ctx);
  }
}
