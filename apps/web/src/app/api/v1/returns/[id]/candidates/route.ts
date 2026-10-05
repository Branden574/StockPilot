import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/returns/[id]/candidates?line=<order line id>&q= — the
 * replacement picker for one returned line (return_exchange_candidates,
 * security invoker: the caller's item scope applies; returns RX-2). The
 * returned item's size siblings first, then name and SKU matches from two
 * characters, 30 at most, each with free stock (on hand minus every active
 * hold).
 *
 * 200 { organizationId, orderId, orderRequestLineId, returnedItemId,
 * groupId, siblings, matches } · 400 · 401 · 403 · 404 · 429.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bad = invalidReturnId(id);
  if (bad) return bad;
  const gate = await returnsContext(req, 'read');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  const sp = new URL(req.url).searchParams;
  const parsed = parseReturnBody('candidates', { line: sp.get('line') ?? '', q: sp.get('q') });
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const answer = await RMAService.forApiContext(ctx).candidates(id, parsed.value);
    return NextResponse.json({ organizationId: ctx.organizationId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.candidates', ctx);
  }
}
