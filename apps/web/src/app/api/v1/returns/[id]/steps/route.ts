import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/steps — approve, receive and process in that
 * order (plan 3.3.8, graft G2), each ONE database transaction:
 *
 *   body { steps: ('approve' | 'receive' | 'process')[],
 *          expectedRevision, expectedPlanSeq,
 *          approve?: { lines: [{ returnLineId, disposition, restock? }] },
 *          receiveNow?: boolean,          // "Approve and receive", one step
 *          process?: { lines } | null }   // a destination changed at processing
 *
 * A step already reached answers `already`; the first refusal stops the
 * chain (earlier steps stay committed). The answer always carries the whole
 * workbench, so a lost answer is recovered by sending the same body again.
 * Cookie or Bearer; returns:manage, write access to the order's warehouse
 * (checked in the database), the MFA step-up.
 *
 * 200 { ran: [{ step, outcome, reason?, message? }], workbench } · 400 ·
 * 401 · 403 · 404 · 429.
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
  const parsed = parseReturnBody('steps', read.body);
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const result = await RMAService.forApiContext(ctx).runSteps(id, parsed.value);
    return NextResponse.json({ organizationId: ctx.organizationId, ...result }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.steps', ctx);
  }
}
