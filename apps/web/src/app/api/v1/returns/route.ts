import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnListFilter } from '@stockpilot/core';

import { RMAService } from '@/server/services/returns';

import { NO_STORE, returnsContext, returnsErrorResponse } from './http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/returns?filter=&q=&cursor= — the returns list (returns RX-1,
 * plan 3.10): one page of 25 from `return_overview`, keyset paged, with the
 * first two returning items per row (names, sizes, thumbnails). Cookie or
 * Bearer; returns:read or returns:manage; the returns module on.
 *
 * filter: all | awaiting_approval | waiting_for_return |
 *   received_not_processed | closed (RX-2 adds the exchange filters; an
 *   unknown value reads as all). q: RMA number, SO number, requester name or
 *   email. cursor: the previous page's `nextCursor`.
 *
 * 200 { organizationId, filter, q, rows, nextCursor, pageSize } · 401 · 403
 * (module off, missing permission, MFA) · 429.
 */
export async function GET(req: NextRequest) {
  const gate = await returnsContext(req, 'read');
  if ('response' in gate) return gate.response;
  const { ctx } = gate;
  const url = new URL(req.url);
  try {
    const page = await RMAService.forApiContext(ctx).listPage({
      filter: parseReturnListFilter(url.searchParams.get('filter')),
      q: url.searchParams.get('q'),
      cursor: url.searchParams.get('cursor'),
    });
    return NextResponse.json(page, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.returns.list', ctx);
  }
}
