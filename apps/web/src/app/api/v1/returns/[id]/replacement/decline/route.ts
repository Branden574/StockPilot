import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement/decline — "Close as return only"
 * after a replacement cancel (decline_return_replacement, migration 0397;
 * desk check F9): the exchange lines the cancel left cancelled are declined
 * for good, so the RMA (closed or not) stops inviting a new replacement.
 *
 * body { expectedRevision, reason }: the RMA revision the caller saw (a stale
 * one is 409 return_changed) and a reason of 1 to 1,000 characters (kept on
 * the RMA, never shown to the requester). No order is touched and nothing
 * moves; no cancelled line answers changed false.
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
  const parsed = parseReturnBody('declineReplacement', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.declineReplacement(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.decline', ctx);
  }
}
