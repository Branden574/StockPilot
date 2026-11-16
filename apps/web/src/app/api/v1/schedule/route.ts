import { revalidatePath } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

import { createScheduleEventSchema } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { ScheduleService } from '@/server/services/schedule';

import {
  CHANGE_BODY_NOT_JSON_MESSAGE,
  changeErrorResponse,
  changeRateLimitedResponse,
  changeValidationResponse,
} from '../change-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/schedule: put one event on the Schedule. Cookie, or a Bearer
 * token for clients that hold one.
 *
 * Body: the Schedule form's own fields, read by core's
 * createScheduleEventSchema, the schema createScheduleEventAction reads:
 * `{ title, startsAt, endsAt?, allDay?, locationText?, warehouseId?,
 * requesterName?, details?, status?, bundleId?, bundleQuantity?,
 * bundleWarehouseId? }`.
 *
 * The event is made by ScheduleService.create, as on the website, under the
 * caller's own session: the Schedule module, schedule:manage (with the
 * organization's authenticator rule), write access to the event's warehouse
 * and to a linked kit's warehouse. The service writes the event's
 * `schedule.created` audit row, with the caller as the actor; this route
 * writes none. An audit row that cannot be written is reported, and the event
 * stands, as on the website.
 *
 * Answers:
 *   201 `{ ok: true, id }`;
 *   400 `validation_error`: a body that is not JSON or that the schema refuses
 *       (its first sentence);
 *   401 `unauthenticated`: no session, or a session that still owes its
 *       authenticator code (withApiContext gives it no context);
 *   403 `forbidden` (with `details.reason` mfa_required when the
 *       organization requires an authenticator and the account has none),
 *       `forbidden` for a warehouse the caller cannot write, or
 *       `module_disabled`;
 *   429 `rate_limited`, with Retry-After (60 events a minute per account);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed`: from the API context gate, when the caller's access
 *       or the Schedule module's state could not be read, so nothing here
 *       ran; or when the warehouse check could not read the caller's own
 *       access, before the event is written. The same request may be sent
 *       again.
 */
export async function POST(req: NextRequest) {
  // First, before the rate limit, the body or the write (server/lib/api-context-gate.ts).
  const gate = await apiContextGate(req, { modules: ['schedule'] });
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const rl = await checkRateLimit(`schedule-create:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) return changeRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return changeValidationResponse(CHANGE_BODY_NOT_JSON_MESSAGE);
  }
  const parsed = createScheduleEventSchema.safeParse(body);
  if (!parsed.success) {
    return changeValidationResponse(parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  let id: string;
  try {
    ({ id } = await new ScheduleService(ctx).create(parsed.data));
  } catch (e) {
    return changeErrorResponse(e, 'api.v1.schedule.create', ctx.organizationId);
  }

  // The web action refreshes the Schedule pages. The event is saved at this point,
  // so a refresh that fails is reported, never answered.
  try {
    revalidatePath('/dashboard/schedule');
  } catch (e) {
    void reportError(e, {
      tag: 'api.v1.schedule.create.revalidate',
      organizationId: ctx.organizationId,
    });
  }
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
