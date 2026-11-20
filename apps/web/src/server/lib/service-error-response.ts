import 'server-only';

import { NextResponse } from 'next/server';

import {
  forbiddenOrInternalResponse,
  type InternalErrorResponseOptions,
} from '@/server/lib/api-error-response';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';

/**
 * A route's answer to whatever its catch received, when the route has no
 * error shape of its own.
 *
 * A ServiceError other than internal_error keeps its code and its words, with
 * the status serviceErrorStatus gives the code (401 unauthenticated, 403
 * forbidden and module_disabled, 404 not_found, 400 validation_error, 409
 * conflict and plan_limit_exceeded), plus the `details` the service wrote (a
 * reason such as aal2_required) when it wrote any. These are the caller's
 * answers, not faults, so nothing is reported.
 *
 * A warehouse check's ForbiddenError (lib/auth/warehouse.ts) answers as
 * forbiddenOrInternalResponse answers it: 403 forbidden with its words, or,
 * when the caller's own warehouse access could not be read
 * (accessUnreadable), the retryable 503 check_failed with Retry-After,
 * reported as a warning.
 *
 * An internal_error, and anything else, goes to internalErrorResponse:
 * reported once under the route's tag (the reporter logs the service's
 * internalDetail, never the database's row details), and answered with the
 * fixed sentence at 500. Its details are never sent.
 *
 * The area helpers app/api/v1/change-error-response.ts,
 * app/api/v1/exceptions/error-response.ts and app/api/v1/returns/http.ts
 * answer the same way in their own shapes.
 */
export function serviceErrorResponse(
  e: unknown,
  tag: string,
  opts: InternalErrorResponseOptions = {},
): NextResponse {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return NextResponse.json(
      { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      { status: serviceErrorStatus(e.code) },
    );
  }
  return forbiddenOrInternalResponse(e, tag, opts);
}
