import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement/close-rest — "Close the rest"
 * (close_return_replacement_rest, migration 0397, returns RX-4; RX-2
 * verification V3): a replacement handed over in part whose rest is on
 * backorder, under an RMA already received or closed, is closed as
 * delivered-partial. The rest is never sent; what was handed over stays.
 *
 * body { expectedRevision, reason, shownStatus? }: the RMA revision the
 * caller saw, a reason of 1 to 1,000 characters (kept on the RMA, never shown
 * to the requester) and the replacement status the screen showed (a newer
 * one is 409 return_changed). Nothing on backorder handed over in part any
 * more is 409 replacement_not_backordered; an earlier close of the same rest
 * answers changed false.
 *
 * 200 { organizationId, answer, workbench } · 400 · 401 · 403 · 404 · 409 · 429.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bad = invalidReturnId(id);
  if (bad) return bad;
  const gate = await returnsContext(req, 'write');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const parsed = parseReturnBody('closeReplacementRest', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.closeReplacementRest(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.close_rest', ctx);
  }
}
