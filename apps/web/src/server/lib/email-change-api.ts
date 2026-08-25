import 'server-only';

import { NextResponse } from 'next/server';

import { ServiceError, type ServiceContext } from '@/server/services/context';

import type { MfaPosture } from '@/server/services/email-change';

/**
 * Shared glue for the Bearer twins under /api/v1/account/email/*. The rules
 * live in services/email-change.ts; these two helpers only translate the
 * caller's context and the service's errors into the mobile contract.
 */

/** MFA posture as withApiContext already resolved it from the verified token. */
export function mfaPostureFromContext(ctx: ServiceContext): MfaPosture {
  return { enrolled: !!ctx.mfaEnrolled, aal2: ctx.mfaSatisfied };
}

/**
 * Same code → status mapping the rest of /api/v1 uses. Two `forbidden`
 * reasons get their own shape because the mobile client acts on them:
 * `aal2_required` opens the TOTP step-up, `rate_limited` becomes a 429.
 */
export function emailChangeErrorResponse(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (reason === 'rate_limited') {
      return NextResponse.json({ error: 'rate_limited', message: e.message }, { status: 429 });
    }
    if (reason === 'aal2_required') {
      return NextResponse.json({ error: 'aal2_required', message: e.message }, { status: 403 });
    }
    const status =
      e.code === 'validation_error'
        ? 400
        : e.code === 'unauthenticated'
          ? 401
          : e.code === 'forbidden'
            ? 403
            : e.code === 'not_found'
              ? 404
              : e.code === 'conflict'
                ? 409
                : 500;
    return NextResponse.json({ error: e.code, message: e.message }, { status });
  }
  return NextResponse.json(
    { error: 'internal_error', message: 'Something went wrong. Please try again.' },
    { status: 500 },
  );
}
