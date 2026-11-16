import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { forbiddenOrInternalResponse } from '@/server/lib/api-error-response';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/**
 * The one error shape of the schedule, serial number and customer status
 * routes (app/api/v1/schedule, items/[id]/serials, serials/[id],
 * customers/[id]/status): `{ error: <code>, message, details? }`. The members
 * routes answer the same way (app/api/v1/members/error-response.ts).
 */

/** The sentence for a request the rate limiter refused. */
export const CHANGE_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

/** The sentence for a body that is not JSON. */
export const CHANGE_BODY_NOT_JSON_MESSAGE = 'The request body is not valid JSON.';

/** A 429 in the routes' error shape, with Retry-After. */
export function changeRateLimitedResponse(resetAt: number): NextResponse {
  return NextResponse.json(
    { error: 'rate_limited', message: CHANGE_RATE_LIMITED_MESSAGE, retryAt: resetAt },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) },
    },
  );
}

/** A 400 `validation_error` with the route's sentence. */
export function changeValidationResponse(message: string): NextResponse {
  return NextResponse.json({ error: 'validation_error', message }, { status: 400 });
}

/**
 * A ServiceError keeps its code and its words, with the status
 * serviceErrorStatus gives the code (403 forbidden and module_disabled, 404
 * not_found, 409 conflict and plan_limit_exceeded, 400 validation_error).
 * `details` carries the reason the service wrote (mfa_required from the
 * authenticator rule, the duplicate serial numbers), which a caller can act
 * on. A session that still owes its authenticator code never reaches a
 * service: withApiContext gives it no context and the route answers 401. An
 * internal_error answers the service's fixed sentence (the class never holds
 * the database's text as its message), sends no details, and is reported with
 * the route's tag. A warehouse check whose read of the caller's own access
 * failed (a ForbiddenError with accessUnreadable, thrown as it is by
 * ScheduleService.create) is the retryable 503 check_failed; any other
 * ForbiddenError is 403 with its words; anything else answers
 * internalErrorResponse's fixed sentence and is reported there.
 */
export function changeErrorResponse(e: unknown, tag: string, organizationId: string): NextResponse {
  if (e instanceof ServiceError) {
    const internal = e.code === 'internal_error';
    if (internal) void reportError(e, { tag, organizationId });
    const details = internal ? undefined : e.details;
    return NextResponse.json(
      { error: e.code, message: e.message, ...(details ? { details } : {}) },
      { status: serviceErrorStatus(e.code) },
    );
  }
  return forbiddenOrInternalResponse(e, tag, { organizationId });
}
