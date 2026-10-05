import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement/prepare — "Get replacement ready"
 * (plan 3.3.8): the live replacement through the existing order steps (pick
 * slip, a claim when the caller is not a manager, the one-click pick,
 * packing slips, staging), each with its own gates and transaction, skipping
 * what is done, stopping at the first refusal and before the signature.
 *
 * body {} or { stopAt: 'staged' }.
 *
 * 200 { organizationId, answer: { orderId, ran: [{ step, outcome, reason?,
 * message? }], status, fulfillmentType }, workbench } · 400 · 401 · 403 ·
 * 404 · 409 · 429.
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
  const parsed = parseReturnBody('prepare', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.prepareReplacement(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.prepare', ctx);
  }
}
