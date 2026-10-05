import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement/cancel — keep the return, cancel the
 * replacement (cancel_return_replacement, migration 0397; X-1, X-2).
 *
 * body { expectedRevision?, reason } (a reason of 1 to 1,000 characters,
 * kept on the RMA, never shown to the requester). Undrawn: its holds are
 * released. Picked or staged: the picked batch goes back to Staging on
 * record (answer.drawn). Handed over: 409 replacement_handed_over. Nothing
 * live: changed false.
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
  const parsed = parseReturnBody('cancelReplacement', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.cancelReplacement(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.cancel', ctx);
  }
}
