import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid } from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { MAX_SERIAL_LENGTH, SERIAL_STATUSES, SerialsService } from '@/server/services/serials';

import {
  CHANGE_BODY_NOT_JSON_MESSAGE,
  changeErrorResponse,
  changeRateLimitedResponse,
  changeValidationResponse,
} from '../../change-error-response';
import { revalidateItemPages } from '../revalidate-item-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The sentence for a path id that is not a uuid. */
const SERIAL_ID_INVALID_MESSAGE = 'That serial number id is not valid.';

// updateItemSerialAction's body, without the serial id (it is the path's).
const patchSchema = z
  .object({
    serialNumber: z
      .string()
      .min(1)
      .max(MAX_SERIAL_LENGTH * 4)
      .optional(),
    status: z.enum(SERIAL_STATUSES).optional(),
  })
  .refine((v) => v.serialNumber !== undefined || v.status !== undefined, {
    message: 'Nothing to update.',
  });

/**
 * PATCH /api/v1/serials/[id]: change one serial number's text, its status,
 * or both. Cookie, or a Bearer token for clients that hold one. `[id]` is the
 * serial_registry row's id, in either case; it is lower-cased before use.
 *
 * Body: `{ serialNumber?, status? }`, at least one, as updateItemSerialAction
 * reads it. `status` is one of available, reserved, damaged, rejected, sold,
 * rma.
 *
 * The change is SerialsService.updateSerial, as on the item page, under the
 * caller's own session: items:update (with the organization's authenticator
 * rule), the row read in the caller's organization before the write. The
 * service writes one `item.serial.updated` audit row (entity the item,
 * before and after number and status, the serial's id), with the caller as
 * the actor; this route writes none. An audit row that cannot be written is
 * reported, and the change stands, as on the website.
 *
 * Answers:
 *   200 `{ ok: true, id, itemId, serialNumber, status }`;
 *   400 `validation_error`: an id that is not a uuid, a body that is not JSON
 *       or names nothing to change, an unknown status, an empty or too long
 *       number;
 *   401 `unauthenticated`: no session, or a session that still owes its
 *       authenticator code (withApiContext gives it no context);
 *   403 `forbidden` (with `details.reason` mfa_required when the
 *       organization requires an authenticator and the account has none);
 *   404 `not_found`: no such serial number in the caller's organization;
 *   409 `conflict`: the number is already on the item;
 *   429 `rate_limited`, with Retry-After (120 changes a minute per account,
 *       shared with DELETE);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed` from the API context gate: nothing here ran, and the
 *       same request may be sent again.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // First, before the id, the rate limit, the body or the write.
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return changeValidationResponse(SERIAL_ID_INVALID_MESSAGE);
  const serialId = id.toLowerCase();

  const rl = await checkRateLimit(`serial-change:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return changeRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return changeValidationResponse(CHANGE_BODY_NOT_JSON_MESSAGE);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return changeValidationResponse(parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let updated: Awaited<ReturnType<SerialsService['updateSerial']>>;
  try {
    updated = await new SerialsService(ctx).updateSerial(serialId, {
      ...(parsed.data.serialNumber !== undefined ? { serialNumber: parsed.data.serialNumber } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    });
  } catch (e) {
    return changeErrorResponse(e, 'api.v1.serials.update', ctx.organizationId);
  }

  revalidateItemPages(updated.itemId, ctx.organizationId, 'api.v1.serials.update.revalidate');
  return NextResponse.json({
    ok: true,
    id: updated.id,
    itemId: updated.itemId,
    serialNumber: updated.serialNumber,
    status: updated.currentStatus,
  });
}

/**
 * DELETE /api/v1/serials/[id]: remove one serial number that was added by
 * hand. Cookie or Bearer. `[id]` as for PATCH.
 *
 * The removal is SerialsService.remove, as on the item page: items:update
 * (with the authenticator rule), the row read in the caller's organization,
 * and a serial number captured at a purchase order receipt refused (mark it
 * damaged or rejected instead). The service writes one `item.serial.deleted`
 * audit row (entity the item, the number that was removed, the serial's id),
 * with the caller as the actor; this route writes none. An audit row that
 * cannot be written is reported, and the removal stands, as on the website.
 *
 * Answers:
 *   200 `{ ok: true, itemId }`;
 *   400 `validation_error`: an id that is not a uuid;
 *   401, 403, 429, 500 and 503 as for PATCH;
 *   404 `not_found`: no such serial number in the caller's organization, or
 *       it was removed meanwhile;
 *   409 `conflict`: captured at a receipt, so it cannot be removed.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // First, before the id, the rate limit or the write.
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return changeValidationResponse(SERIAL_ID_INVALID_MESSAGE);
  const serialId = id.toLowerCase();

  const rl = await checkRateLimit(`serial-change:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return changeRateLimitedResponse(rl.resetAt);

  let itemId: string;
  try {
    ({ itemId } = await new SerialsService(ctx).remove(serialId));
  } catch (e) {
    return changeErrorResponse(e, 'api.v1.serials.delete', ctx.organizationId);
  }

  revalidateItemPages(itemId, ctx.organizationId, 'api.v1.serials.delete.revalidate');
  return NextResponse.json({ ok: true, itemId });
}
