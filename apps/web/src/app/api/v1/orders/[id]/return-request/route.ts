import { NextResponse, type NextRequest } from 'next/server';

import { parseReturnBody } from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';
import { mfaGateError } from '@/server/services/context';
import { createMemberReturn } from '@/server/services/returns';
import { loadMemberReturnSheet } from '@/server/services/returns-requester';

import { badBody, NO_STORE, readJson, returnsErrorResponse } from '../../../returns/http';

import { memberRequesterGate, orderNotAvailable } from './http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A member requester's "Return or exchange" on their OWN completed order
 * (returns RX-3; the phone's sheet, Bearer, and the web, cookie). The gate
 * (./http.ts): signed in with an enabled account (else 401), per-user
 * limits, the returns module on (else 403), and the order the caller's own
 * (requester_user_id = the caller, in their organization, not a portal
 * order, returnable): anything else is the one 404.
 *
 * GET  -> 200 { organizationId, orderId, ...RequesterReturnSheet }
 *         { orderNumber, requesterName, exchangesEnabled,
 *           lines: [{ orderRequestLineId, name, sizeLabel, photo,
 *                     quantityFulfilled, quantityRemaining }],
 *           tracking: [{ returnNumber, createdAt, returnStatus, exchangeStatus,
 *                        sentences, replacementOrderNumber, lines }] }
 *
 * POST { reasonCode?, notes?, lines: [{ orderRequestLineId, quantity,
 *        exchange?: { itemId?, quantity?, note? } }], idempotencyKey? }
 *      -> 200 { id, returnNumber, replay }
 *
 * The POST is the same database function as the token and portal paths
 * (create_requester_return_request, channel member, service role after this
 * server resolved the order): every line, the budget, the item and the
 * exchange are re-checked in one transaction; a disposition, a status, a
 * warehouse, a location or an approved item in the body is stripped by
 * core's schema (and refused inside `exchange`). The MFA floor applies to
 * the write, as to every other member write. A body without a key gets a
 * fresh one (exactly as safe as before keys existed).
 */

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await memberRequesterGate(req, params, 'read');
  if ('response' in gate) return gate.response;
  const { ctx, orderId } = gate;
  try {
    const sheet = await loadMemberReturnSheet(createAdminClient(), {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      orderRequestId: orderId,
    });
    if (!sheet) return orderNotAvailable();
    return NextResponse.json({ organizationId: ctx.organizationId, orderId, ...sheet }, { headers: NO_STORE });
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.orders.return_request.get', ctx);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await memberRequesterGate(req, params, 'write');
  if ('response' in gate) return gate.response;
  const { ctx, orderId } = gate;
  if (ctx.mfaRequired && !ctx.mfaSatisfied) return returnsErrorResponse(mfaGateError(ctx), 'api.v1.orders.return_request.create', ctx);

  const json = await readJson(req);
  if (!json.ok) return json.response;
  const parsed = parseReturnBody('requester', json.body);
  if (!parsed.ok) return badBody(parsed.message);
  const body = parsed.value;

  try {
    const created = await createMemberReturn(
      createAdminClient(),
      { organizationId: ctx.organizationId, userId: ctx.userId, orderRequestId: orderId },
      { reasonCode: body.reasonCode ?? null, notes: body.notes ?? null, lines: body.lines },
      { idempotencyKey: body.idempotencyKey ?? null },
    );
    return NextResponse.json(
      { id: created.id, returnNumber: created.returnNumber, replay: created.replay },
      { headers: NO_STORE },
    );
  } catch (e) {
    return returnsErrorResponse(e, 'api.v1.orders.return_request.create', ctx);
  }
}
