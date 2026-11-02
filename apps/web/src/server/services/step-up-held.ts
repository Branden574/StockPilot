import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readVerifiedSessionClaimsOf } from '@/lib/auth/verified-claims';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, mfaGateError } from '@/server/services/context';

import { stepUpOwed } from '@stockpilot/core';

/**
 * The sentence for a session that no longer verifies as the account the
 * action validated: it ended during the action, or it holds another account.
 * Normal use never shows it.
 */
export const SESSION_CHANGED = 'Sign in again, then try again.';

/** The refusal behind SESSION_CHANGED: `unauthenticated`, reason `session_changed`. */
export function sessionChangedError(): ServiceError {
  return new ServiceError('unauthenticated', SESSION_CHANGED, { reason: 'session_changed' });
}

/**
 * The authenticator step-up of ONE account, the account the action validated
 * (docket S50a), decided from that account's own facts only:
 *  - the level: the cookie session's verified claims, only when their subject
 *    is `userId` (readVerifiedSessionClaimsOf);
 *  - the factors: GoTrue's list for `userId`, read by id with the service role.
 * core's stepUpOwed decides: a verified factor of any type, and a session that
 * is not aal2.
 *
 * Throws, in order:
 *  - `unauthenticated` (SESSION_CHANGED, reason `session_changed`) when there
 *    is no verified session of `userId`;
 *  - `internal_error` when the factors cannot be read: it fails closed, and
 *    the failure is reported;
 *  - `forbidden` with reason `aal2_required` (mfaGateError's enrolled shape)
 *    when the code is owed.
 *
 * A last check right before a privileged service-role write that other reads
 * of the cookie session came before: account deletion runs it immediately
 * before the delete. It lives apart from services/context.ts so the context's
 * own gate is untouched.
 */
export async function assertStepUpHeld({
  supabase,
  admin,
  userId,
}: {
  supabase: Pick<SupabaseClient, 'auth'>;
  admin: Pick<SupabaseClient, 'auth'>;
  userId: string;
}): Promise<void> {
  const claims = await readVerifiedSessionClaimsOf(supabase, userId);
  if (!claims) throw sessionChangedError();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error || !data) {
    // Never the id: a fixed tag, so an outage that refuses here shows.
    void reportError(new Error(error?.message || 'listFactors returned no data'), {
      tag: 'auth.step_up_held.factors_unreadable',
      level: 'warning',
    });
    throw new ServiceError(
      'internal_error',
      'Could not check your two-factor status. Please try again.',
    );
  }
  if (stepUpOwed(data.factors, claims.aal)) throw mfaGateError({ mfaEnrolled: true });
}
