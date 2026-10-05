import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/replacement — change the replacement (a
 * substitution) or issue a new one after a replacement cancel (C-1)
 * (change_return_replacement, migration 0397; returns RX-2).
 *
 * body { expectedRevision, lines: [{ exchangeLineId, itemId?, quantity? }],
 *        reason, whenShort?: 'refuse' | 'backorder',
 *        replacement?: { fulfillmentType?, deliveryCharterId? } }
 *
 * The undrawn live replacement is cancelled (holds released) and a new one
 * created and held in ONE transaction; a picked or handed-over one is refused
 * (409 replacement_already_drawn / replacement_handed_over). Short with
 * whenShort 'refuse': 400 replacement_unavailable with details.detail
 * [{ itemId, needed, available }]. Idempotent on (RMA, expectedRevision); a
 * different change at the same revision answers 409 return_changed.
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
  const parsed = parseReturnBody('changeReplacement', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const svc = RMAService.forApiContext(ctx);
    const answer = await svc.changeReplacement(id, parsed.value);
    const workbench = await svc.workbench(id);
    return NextResponse.json({ organizationId: ctx.organizationId, answer, workbench }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.replacement.change', ctx);
  }
}
