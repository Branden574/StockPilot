import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import type { ServiceContext } from '@/server/services/context';
import { recordReturnRequestDrafted } from '@/server/services/return-request-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * POST /api/v1/orders/[id]/return-request-drafted (F14, the phone).
 * Body: { returnNumber, isCondensed, surface: 'order' | 'return' }.
 *
 * Records that a return request DRAFT was opened, after the phone's operating
 * system opened a mail app with it. That one fact is all StockPilot knows: it
 * cannot see Send, delivery or a ticket, and this answer never says more.
 *
 *   401  not signed in (or a disabled account)
 *   400  the order id is not a uuid
 *   200  { recorded: true }  the row was written
 *   200  { recorded: false } nothing was written: the module is off, the
 *        order is not in the caller's organization, the caller is neither
 *        the order's requester nor a returns reader, the return is not on
 *        that order or is no longer open, the session owes a two-step
 *        sign-in, the member is past 60 an hour, or the body is malformed.
 *        One answer for all of them, so the route tells nobody which orders
 *        or return numbers exist.
 *
 * Every check is the service's (services/return-request-draft.ts), the same
 * function the website's action calls.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let ctx: ServiceContext | null;
  try {
    ctx = await withApiContext(req);
  } catch (e) {
    void reportError(e, { tag: 'api.v1.orders.return_request_drafted.context' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
  }
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401, headers: NO_STORE });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'That order id is not valid.' },
      { status: 400, headers: NO_STORE },
    );
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  // The service never throws, and holds the limit and every check; the order
  // id is the path's, never the body's.
  const res = await recordReturnRequestDrafted(ctx, {
    orderId: id,
    returnNumber: fields.returnNumber,
    isCondensed: fields.isCondensed,
    surface: fields.surface,
  });
  return NextResponse.json(res, { headers: NO_STORE });
}
