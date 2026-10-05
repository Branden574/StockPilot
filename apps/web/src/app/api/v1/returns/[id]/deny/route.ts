import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/deny — requested → denied (deny_return).
 * body { reason } (1 to 1,000 characters; the requester is told the request
 * was declined, never the reason). Already denied answers changed false.
 *
 * 200 { organizationId, changed, status, by, byName, at } · 400 · 401 · 403
 * · 404 · 409 (the RMA moved on) · 429.
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
  const parsed = parseReturnBody('deny', read.body);
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const answer = await RMAService.forApiContext(ctx).deny(id, parsed.value.reason);
    return NextResponse.json({ organizationId: ctx.organizationId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.deny', ctx);
  }
}
