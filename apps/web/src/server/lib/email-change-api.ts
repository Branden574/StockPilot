import 'server-only';

import { NextResponse } from 'next/server';

import { ServiceError, type ServiceContext } from '@/server/services/context';

import type { MfaPosture } from '@/server/services/email-change';

/**
 * Shared glue for the Bearer twins under /api/v1/account/email/*. The rules
 * live in services/email-change.ts; these two helpers only translate the
 * caller's context and the service's errors into the mobile contract.
 */

/**
 * MFA posture as withApiContext already resolved it: the level from the
 * verified token, and the organization's policy for the member's role
 * (mfaFromPolicy in lib/auth/api-context.ts, an unreadable or hidden policy
 * held to the strictest one). A policy that requires an authenticator of a
 * member who has none verified resolves to required, not satisfied and not
 * enrolled: that member owes set-up.
 */
export function mfaPostureFromContext(ctx: ServiceContext): MfaPosture {
  const enrolled = !!ctx.mfaEnrolled;
  return {
    enrolled,
    aal2: ctx.mfaSatisfied,
    setUpOwed: ctx.mfaRequired && !ctx.mfaSatisfied && !enrolled,
  };
}

/**
 * Same code → status mapping the rest of /api/v1 uses. Three `forbidden`
 * reasons keep their own code: `aal2_required`, for which the phone shows its
 * authenticator prompt (sign out and sign back in with the code);
 * `mfa_required` (set up an authenticator first, the account-delete route's
 * code), whose sentence the phone shows; and `rate_limited`, a 429.
 */
export function emailChangeErrorResponse(e: unknown): NextResponse {
  if (e instanceof ServiceError) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (reason === 'rate_limited') {
      return NextResponse.json({ error: 'rate_limited', message: e.message }, { status: 429 });
    }
    if (reason === 'aal2_required' || reason === 'mfa_required') {
      return NextResponse.json({ error: reason, message: e.message }, { status: 403 });
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
