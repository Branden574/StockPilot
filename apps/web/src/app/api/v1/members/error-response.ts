import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/** The sentence for a request the rate limiter refused. */
export const MEMBERS_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

/** The sentence for a path id that is not a uuid. */
export const MEMBER_ID_INVALID_MESSAGE = 'That member id is not valid.';

/** A 429 in the routes' error shape, with Retry-After. */
export function membersRateLimitedResponse(resetAt: number): NextResponse {
  return NextResponse.json(
    { error: 'rate_limited', message: MEMBERS_RATE_LIMITED_MESSAGE, retryAt: resetAt },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))) },
    },
  );
}

/**
 * The /api/v1/members routes' one error shape:
 * `{ error: <code>, message, details? }`.
 *
 * A ServiceError keeps its code and its words, with the status
 * serviceErrorStatus gives the code (403 forbidden, 404 not_found, 409
 * conflict, 400 validation_error). `details` carries the reason the service
 * wrote (aal2_required or mfa_required from the authenticator gate), which a
 * caller can act on. An internal_error answers the service's fixed sentence (the
 * class never holds the database's text as its message), sends no details,
 * and is reported with the route's tag. Anything else answers
 * internalErrorResponse's fixed sentence and is reported there.
 *
 * Takes the organization id, for the report, and not the context.
 */
export function membersErrorResponse(
  e: unknown,
  tag: string,
  organizationId: string,
): NextResponse {
  if (e instanceof ServiceError) {
    const internal = e.code === 'internal_error';
    if (internal) void reportError(e, { tag, organizationId });
    const details = internal ? undefined : e.details;
    return NextResponse.json(
      { error: e.code, message: e.message, ...(details ? { details } : {}) },
      { status: serviceErrorStatus(e.code) },
    );
  }
  return internalErrorResponse(e, tag, { organizationId });
}
