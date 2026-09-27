import { NextResponse } from 'next/server';

import { VERIFICATION_SESSION_ENDED_COPY, VERIFICATION_UNAVAILABLE_COPY } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus, type ServiceContext } from '@/server/services/context';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * The verification routes' one error shape: `{ error: <code>, message,
 * details? }` (the phone shows `message`), never cached.
 *
 * A refusal the service authored (403 without items:read or at the MFA
 * step-up, 404 for an item or location the reader cannot see, 400 for a bad
 * id) keeps its own words and `details` (the phone branches on
 * details.reason, e.g. aal2_required). ANY other failure is a read that did
 * not complete, and says exactly that: 500 with "Couldn't load verification".
 * It is never answered as an empty summary, which the phone would render as
 * "No physical count on record." Raw database text never leaves the server.
 */
export function verificationErrorResponse(
  e: unknown,
  tag: string,
  ctx: Pick<ServiceContext, 'organizationId'>,
): NextResponse {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return NextResponse.json(
      { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      { status: serviceErrorStatus(e.code), headers: NO_STORE },
    );
  }
  void reportError(e, { tag, organizationId: ctx.organizationId });
  return NextResponse.json(
    { error: 'internal_error', message: VERIFICATION_UNAVAILABLE_COPY },
    { status: 500, headers: NO_STORE },
  );
}

/** No session: 401 in the same shape, with the words the phone shows for it
 *  (core VERIFICATION_SESSION_ENDED_COPY). */
export function verificationUnauthenticatedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'unauthenticated', message: VERIFICATION_SESSION_ENDED_COPY },
    { status: 401, headers: NO_STORE },
  );
}
