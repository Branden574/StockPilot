import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid } from '@stockpilot/core';

import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { MAX_SERIAL_LENGTH, MAX_SERIALS_PER_ADD, SerialsService } from '@/server/services/serials';

import {
  CHANGE_BODY_NOT_JSON_MESSAGE,
  changeErrorResponse,
  changeRateLimitedResponse,
  changeValidationResponse,
} from '../../../change-error-response';
import { revalidateItemPages } from '../../../serials/revalidate-item-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The sentence for a path id that is not a uuid. */
const ITEM_ID_INVALID_MESSAGE = 'That item id is not valid.';

// addItemSerialsAction's body, without the item id (it is the path's).
const bodySchema = z.object({
  warehouseId: z.string().uuid(),
  serials: z
    .array(z.string().max(MAX_SERIAL_LENGTH * 4))
    .min(1)
    .max(MAX_SERIALS_PER_ADD),
});

/**
 * POST /api/v1/items/[id]/serials: register serial numbers for one item at
 * one warehouse. Cookie or Bearer, so the phone can call it. `[id]` is the
 * item id, in either case; it is lower-cased before use.
 *
 * Body: `{ warehouseId, serials: string[] }`, as addItemSerialsAction reads
 * it (1 to 500 lines; the service trims them, drops empty ones and
 * de-duplicates).
 *
 * The serial numbers are added by SerialsService.add, as on the item page,
 * under the caller's own session: items:update (with the organization's
 * authenticator rule), the item and the warehouse read in the caller's
 * organization, a serial number already on the item refused by name. The
 * service writes one `item.serials.added` audit row (entity the item, the
 * warehouse, the count), with the caller as the actor; this route writes
 * none. An audit row that cannot be written is reported, and the serial
 * numbers stand, as on the website.
 *
 * Answers:
 *   201 `{ ok: true, added }`;
 *   400 `validation_error`: an id that is not a uuid, a body that is not JSON
 *       or not the shape above, a warehouse not in the organization, a serial
 *       number that is too long;
 *   401 `unauthenticated`;
 *   403 `forbidden` (with `details.reason` when the authenticator rule
 *       refused);
 *   404 `not_found`: no such item in the caller's organization;
 *   409 `conflict`: a serial number already on the item (`details.duplicates`);
 *   429 `rate_limited`, with Retry-After (60 a minute per account);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed` from the API context gate: nothing here ran, and the
 *       same request may be sent again.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // First, before the id, the rate limit, the body or the write.
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return changeValidationResponse(ITEM_ID_INVALID_MESSAGE);
  const itemId = id.toLowerCase();

  const rl = await checkRateLimit(`item-serials-add:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) return changeRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return changeValidationResponse(CHANGE_BODY_NOT_JSON_MESSAGE);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return changeValidationResponse(parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let added: number;
  try {
    ({ added } = await new SerialsService(ctx).add(
      itemId,
      parsed.data.warehouseId.toLowerCase(),
      parsed.data.serials,
    ));
  } catch (e) {
    return changeErrorResponse(e, 'api.v1.items.serials.add', ctx.organizationId);
  }

  revalidateItemPages(itemId, ctx.organizationId, 'api.v1.items.serials.add.revalidate');
  return NextResponse.json({ ok: true, added }, { status: 201 });
}
