import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { badBody, invalidReturnId, NO_STORE, readJson, returnsContext, returnsErrorResponse } from '../../http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/returns/[id]/cancel — requested or approved → cancelled
 * (cancel_return). body { expectedRevision?, reason? } (reason optional for
 * a return, up to 1,000 characters). A stale revision answers 409
 * return_changed; already cancelled answers changed false.
 *
 * 200 { organizationId, changed, status, ... } · 400 · 401 · 403 · 404 · 409 · 429.
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
  const parsed = parseReturnBody('cancel', read.body ?? {});
  if (!parsed.ok) return badBody(parsed.message);
  try {
    const answer = await RMAService.forApiContext(ctx).cancel(id, parsed.value);
    return NextResponse.json({ organizationId: ctx.organizationId, ...answer }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.cancel', ctx);
  }
}
