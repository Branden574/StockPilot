import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement/release — release the live
 * replacement for picking before the returned item arrives
 * (release_return_replacement_early, migration 0396; brief 24).
 *
 * body { orderId, reason }: the replacement order the caller saw (another
 * live one, after a substitution or a re-issue, is 409 return_changed: a
 * stale tab never releases an order its user has not seen) and a reason of 1
 * to 500 characters (the presets "Customer is completing an in-person
 * exchange today." and "Swap at delivery: the driver collects the returned
 * item."). Only while the replacement waits at approved and the RMA is
 * approved; it opens the gate for that order only (a substituted order needs
 * its own release). A repeat answers replay; a received RMA answers
 * notNeeded; otherwise 409 replacement_not_waiting.
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
  const parsed = parseReturnBody('releaseEarly', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.releaseEarly(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.release', ctx);
  }
}
