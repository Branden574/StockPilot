'use server';

import {
  ACCOUNT_DISABLED_MESSAGE,
  changeEmailSchema,
  err,
  ok,
  type ActionResult,
  type ChangeEmailInput,
} from '@stockpilot/core';

import { loadAccountStatus, noteDisabledAccountBlocked } from '@/lib/auth/account-status';
import { readVerifiedSessionClaimsOf } from '@/lib/auth/verified-claims';
import { createClient } from '@/lib/supabase/server';
import { ServiceError } from '@/server/services/context';
import {
  cancelEmailChange,
  requestEmailChange,
  resendEmailChange,
  type MfaPosture,
} from '@/server/services/email-change';

/**
 * Web entry points for the verified email change. Thin on purpose: every
 * rule lives in services/email-change.ts so the Bearer twins under
 * /api/v1/account/email enforce exactly the same thing.
 *
 * These authenticate with a bare auth.getUser() — the same identity funnel
 * changePasswordAction uses — so they run the account-status guard
 * themselves, BEFORE anything is spent, with 'unreadable' kept distinct from
 * 'disabled' (a failed read denies but must not tell a healthy user their
 * account was disabled).
 */

interface Principal {
  userId: string;
  mfa: MfaPosture;
}

async function resolvePrincipal(
  path: string,
): Promise<{ ok: true; principal: Principal } | { ok: false; result: ActionResult<never> }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, result: err('unauthenticated', 'Sign in required') };

  const status = await loadAccountStatus(supabase, user.id);
  if (status === 'unreadable') {
    return {
      ok: false,
      result: err('internal_error', 'Could not verify your account status. Please try again.'),
    };
  }
  if (status === 'disabled') {
    noteDisabledAccountBlocked('request', { userId: user.id, path });
    return { ok: false, result: err('forbidden', ACCOUNT_DISABLED_MESSAGE) };
  }

  // MFA posture of the user getUser() named, and of no one else (docket
  // S50a). Enrollment escalates: a verified factor must be satisfied whatever
  // the org policy says.
  //  - Enrolled: a verified factor of any type in the same getUser() answer,
  //    GoTrue's own list for this user (the list a separate factor read would
  //    fetch with one more round trip). An unreadable answer already stopped
  //    above with "Sign in required", never read as "not enrolled".
  //  - aal2: the verified session claims of this same user
  //    (readVerifiedSessionClaimsOf). Anything else is not aal2.
  const enrolled = (user.factors ?? []).some((f) => f.status === 'verified');
  let aal2 = false;
  if (enrolled) {
    const claims = await readVerifiedSessionClaimsOf(supabase, user.id);
    aal2 = claims?.aal === 'aal2';
  }
  return { ok: true, principal: { userId: user.id, mfa: { enrolled, aal2 } } };
}

function fromServiceError(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError) {
    const reason = (e.details as { reason?: string } | undefined)?.reason;
    if (reason === 'rate_limited') return err('rate_limited', e.message);
    return err(e.code, e.message, e.details);
  }
  return err('internal_error', 'Something went wrong. Please try again.');
}

export async function requestEmailChangeAction(
  input: ChangeEmailInput,
): Promise<ActionResult<{ pendingEmail: string; sentAt: string; expiresAt: string }>> {
  const parsed = changeEmailSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  const principal = await resolvePrincipal('requestEmailChangeAction');
  if (!principal.ok) return principal.result;

  try {
    const result = await requestEmailChange({
      userId: principal.principal.userId,
      newEmail: parsed.data.newEmail,
      currentPassword: parsed.data.currentPassword,
      mfa: principal.principal.mfa,
      source: 'web',
    });
    return ok(result);
  } catch (e) {
    return fromServiceError(e);
  }
}

export async function resendEmailChangeAction(): Promise<
  ActionResult<{ pendingEmail: string; sentAt: string; expiresAt: string }>
> {
  const principal = await resolvePrincipal('resendEmailChangeAction');
  if (!principal.ok) return principal.result;
  try {
    const result = await resendEmailChange({
      userId: principal.principal.userId,
      mfa: principal.principal.mfa,
      source: 'web',
    });
    return ok(result);
  } catch (e) {
    return fromServiceError(e);
  }
}

export async function cancelEmailChangeAction(): Promise<ActionResult<{ cancelled: boolean }>> {
  const principal = await resolvePrincipal('cancelEmailChangeAction');
  if (!principal.ok) return principal.result;
  try {
    const result = await cancelEmailChange({ userId: principal.principal.userId, source: 'web' });
    return ok(result);
  } catch (e) {
    return fromServiceError(e);
  }
}
