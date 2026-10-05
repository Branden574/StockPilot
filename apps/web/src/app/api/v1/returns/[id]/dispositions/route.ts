import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/dispositions — change where unapplied lines go
 * while the RMA is approved or received (plan_return_dispositions).
 * body { lines: [{ returnLineId, disposition, restock? }] }. A destination
 * outside the proven sources answers 400 restock_location_not_offered (one
 * answer whatever the cause); an identical plan appends nothing.
 *
 * 200 { organizationId, changed, appended, planSeq } · 400 · 401 · 403 · 404 · 409 · 429.
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
  const parsed = parseReturnBody('dispositions', read.body);
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const answer = await RMAService.forApiContext(ctx).planDispositions(id, parsed.value.lines);
    return NextResponse.json({ organizationId: ctx.organizationId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.dispositions', ctx);
  }
}
