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
import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import { readSessionOrganization } from '@/lib/auth/session';
import { authenticatorSetUpIsOwedByUser } from '@/lib/auth/step-up-gate';
import { readVerifiedSessionClaimsOf } from '@/lib/auth/verified-claims';
import { rethrowControlFlow } from '@/lib/control-flow';
import { createClient } from '@/lib/supabase/server';
import { uncheckedAccessResult } from '@/server/lib/action-error-result';
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
 *
 * Request and resend also ask whether the account must set up an
 * authenticator first in its current organization (setUpOwedInOrganization
 * below); the service then gives the answer the profile's name and avatar
 * give. Cancel does not ask: it only removes a pending change.
 */

interface Principal {
  userId: string;
  mfa: MfaPosture;
}

/** Why the organization that applies could not be told: the label its report carries. */
type SetUpUnchecked = 'no_verified_session' | 'another_account' | 'memberships_unreadable';

/**
 * Does this account owe authenticator set-up in its current organization, the
 * one requireOrgContext() resolves for this request (readSessionOrganization)?
 * The rule requireOrgContext() applies before every page but the security and
 * profile pages, asked here because the profile page is open to such a member
 * (authenticatorSetUpIsOwedByUser, on core's authenticatorSetUpOwed).
 *
 * Called only for an account with no verified factor in its getUser() answer:
 * one with a verified factor cannot owe set-up, and keeps its own rule (aal2).
 * No organization: nothing is owed, as before. An organization row that came
 * back empty is held to the strictest policy; a row read that failed throws
 * OrganizationRowUnavailableError. When the organization that applies cannot
 * be told (no verified session for this request, a session of another
 * account, memberships that did not answer) the answer is `unchecked` with
 * that label. Either way the caller says the access could not be checked, and
 * nothing is changed.
 */
async function setUpOwedInOrganization(user: {
  id: string;
  factors?: ReadonlyArray<{ readonly status?: string | null }> | null;
}): Promise<{ owed: boolean } | { unchecked: SetUpUnchecked }> {
  const read = await readSessionOrganization();
  if (!read.ok) return { unchecked: read.reason };
  if (read.userId !== user.id) return { unchecked: 'another_account' };
  if (!read.organization) return { owed: false };
  return {
    owed: await authenticatorSetUpIsOwedByUser(
      read.organization,
      read.organization.held,
      user.factors,
    ),
  };
}

async function resolvePrincipal(
  path: string,
  opts: { askSetUp: boolean },
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
  let setUpOwed = false;
  if (opts.askSetUp && !enrolled) {
    let answer: Awaited<ReturnType<typeof setUpOwedInOrganization>>;
    try {
      answer = await setUpOwedInOrganization(user);
    } catch (e) {
      // Next control flow (the session load's redirect for a disabled
      // account) is Next's to act on.
      rethrowControlFlow(e);
      return { ok: false, result: fromServiceError(e) };
    }
    if ('unchecked' in answer) {
      // The "could not be checked" sentence, reported with what could not be told.
      const unchecked = new OrganizationRowUnavailableError();
      const extra = { reason: answer.unchecked };
      return {
        ok: false,
        result:
          uncheckedAccessResult(unchecked, 'actions.email_change', { extra }) ??
          fromServiceError(unchecked),
      };
    }
    setUpOwed = answer.owed;
  }
  return { ok: true, principal: { userId: user.id, mfa: { enrolled, aal2, setUpOwed } } };
}

function fromServiceError(e: unknown): ActionResult<never> {
  // A check of the caller's access that could not be read: its own sentence.
  const unchecked = uncheckedAccessResult(e, 'actions.email_change');
  if (unchecked) return unchecked;
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
  const principal = await resolvePrincipal('requestEmailChangeAction', { askSetUp: true });
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
  const principal = await resolvePrincipal('resendEmailChangeAction', { askSetUp: true });
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
  const principal = await resolvePrincipal('cancelEmailChangeAction', { askSetUp: false });
  if (!principal.ok) return principal.result;
  try {
    const result = await cancelEmailChange({ userId: principal.principal.userId, source: 'web' });
    return ok(result);
  } catch (e) {
    return fromServiceError(e);
  }
}
