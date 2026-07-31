'use server';

import { z } from 'zod';

import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import {
  disableUserAccount,
  reenableUserAccount,
  type AccountStatusPartialReason,
} from '@/server/services/platform/account-status';
import { sendPasswordResetForUser } from '@/server/services/platform/users';

import {
  disableReasonSchema,
  err,
  ok,
  type AccountDisableCode,
  type ActionErrorCode,
  type ActionResult,
} from '@stockpilot/core';

const schema = z.object({ targetUserId: z.string().uuid() });

/**
 * Platform-admin action: email a password-reset link to any user. Gated by
 * the platform-admin allowlist (the action re-checks server-side; the UI is
 * already behind the (platform) layout gate). No step-up required — sending a
 * recovery email is non-destructive (the user still must click it).
 */
export async function sendUserPasswordResetAction(
  input: z.infer<typeof schema>,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid user id');

  const gate = await checkPlatformAdmin();
  if (!gate.ok) return err('forbidden', 'Not authorized.');

  const res = await sendPasswordResetForUser({
    targetUserId: parsed.data.targetUserId,
    actorUserId: gate.session.userId,
    actorEmail: gate.session.email,
  });

  if (!res.ok) {
    if (res.reason === 'not_found') return err('not_found', 'User not found.');
    if (res.reason === 'no_email') return err('validation_error', 'That user has no email on file.');
    return err('internal_error', 'Could not send the reset email. Try again.');
  }
  return ok({ ok: true });
}

const disableSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: disableReasonSchema,
});
const reenableSchema = z.object({ targetUserId: z.string().uuid() });

/**
 * The ONE table mapping a service sub-code to its ActionResult transport code
 * and its operator-facing sentence. Exhaustive over AccountDisableCode by type,
 * so adding a code to the shared vocabulary fails the build here until this
 * layer decides how to say it — no silent fall-through to a wrong code.
 *
 * ACCOUNT_STATUS_CHANGED is deliberately a `conflict`, never a `forbidden`: the
 * actor's allowlist membership was already verified before the write, so a lost
 * compare-and-set means someone else moved the row, not that this admin lacks
 * permission. Telling a god admin "not authorized" for a race would send them
 * hunting a permissions problem that does not exist.
 */
const DISABLE_CODE_RESULTS: Record<
  AccountDisableCode,
  { code: ActionErrorCode; message: string }
> = {
  ACCOUNT_TEMPORARILY_DISABLED: { code: 'forbidden', message: 'That account is disabled.' },
  ACCOUNT_ALREADY_DISABLED: { code: 'conflict', message: 'That account is already disabled.' },
  ACCOUNT_NOT_DISABLED: { code: 'conflict', message: 'That account is not disabled.' },
  ACCOUNT_DISABLE_NOT_AUTHORIZED: { code: 'forbidden', message: 'Not authorized.' },
  PROTECTED_ADMIN_ACCOUNT: {
    code: 'forbidden',
    message: 'Platform administrators cannot be disabled.',
  },
  ACCOUNT_DISABLE_REASON_REQUIRED: { code: 'validation_error', message: 'A reason is required.' },
  ACCOUNT_NOT_FOUND: { code: 'not_found', message: 'User not found.' },
  ACCOUNT_STATUS_CHANGED: {
    code: 'conflict',
    message: "That account's status changed while you were working. Reload the page and try again.",
  },
};

function accountStatusFailure(code: AccountDisableCode): ActionResult<never> {
  const mapped = DISABLE_CODE_RESULTS[code];
  return err(mapped.code, mapped.message, { code });
}

/** One clause per partial reason, so the operator is told exactly what is missing. */
const PARTIAL_REASON_CLAUSES: Record<AccountStatusPartialReason, string> = {
  ban_not_applied: 'the sign-in block did not finish applying',
  ban_not_lifted: 'the sign-in block is still in place',
  sessions_not_revoked: 'the existing sessions were not all signed out',
  not_audited: 'the change was not written to the audit log',
};

/**
 * Whether pressing the button again actually heals each gap. Exhaustive over
 * AccountStatusPartialReason by type, so a new reason cannot ship until this
 * layer decides whether the retry it advertises is true.
 *
 * `not_audited` is TRUE as of the fix that stopped the service short-circuiting
 * the audit write on the already-disabled / already-enabled healing path. While
 * it was skipped, this table said false — and the message layer then had to
 * paper over it, which is exactly where the laundering happened.
 */
const PARTIAL_REASON_RETRY_HEALS: Record<AccountStatusPartialReason, boolean> = {
  ban_not_applied: true,
  ban_not_lifted: true,
  sessions_not_revoked: true,
  not_audited: true,
};

/**
 * Turns a half-applied change into an honest failure. The operation DID land
 * its authoritative half, so the wording leads with what is true, names every
 * missing piece, and only then says whether pressing the button again fixes it.
 * `partialReasons` rides in `details` untouched so the surface can render
 * something more specific than this sentence if it wants to.
 */
function partialFailure(opts: {
  lede: string;
  retryHint: string;
  unretryableHint: string;
  code: AccountDisableCode;
  reasons: AccountStatusPartialReason[] | undefined;
}): ActionResult<never> {
  const reasons = opts.reasons ?? [];
  const clauses = reasons.map((r) => PARTIAL_REASON_CLAUSES[r]).filter(Boolean);
  const what = clauses.length > 0 ? clauses.join(', and ') : 'part of it did not finish applying';
  // EVERY named gap must be healable before the retry is promised. `.some()`
  // was the bug: a MIXED set like ['ban_not_applied','not_audited'] had one
  // healable member, so the operator was told "press Disable again to complete
  // it" for a set that included a gap the retry could not close.
  //
  // An empty list means the service reported `partial` without saying why —
  // treat that as retryable, because re-running is the safe default and the
  // whole flow is idempotent. An UNKNOWN reason resolves to undefined here and
  // therefore reads as unhealable, which is the right default for a layer this
  // file has not been taught about yet.
  const retryable =
    reasons.length === 0 || reasons.every((r) => PARTIAL_REASON_RETRY_HEALS[r] === true);
  return err(
    'internal_error',
    `${opts.lede}, but ${what}. ${retryable ? opts.retryHint : opts.unretryableHint}`,
    { code: opts.code, partialReasons: reasons },
  );
}

/**
 * Platform-admin action: temporarily disable any account, platform-wide.
 *
 * Destructive and cross-org, so it sits on the FRESH step-up tier (15-minute
 * MFA assertion) alongside act-as, billing changes and provisioning. A stale
 * step-up comes back as details.reason='aal2_required', which is what lets the
 * client's useStepUp() prompt for TOTP in place and retry once instead of
 * dumping the operator back to sign-in.
 *
 * The target's protected-admin status is decided in the SERVICE, against the
 * VERIFIED auth email — never a profile column a user can edit. For the same
 * reason only the actor's ID is handed down: the service re-resolves that
 * actor's email from GoTrue and re-checks the allowlist itself.
 */
export async function disableUserAccountAction(
  input: z.infer<typeof disableSchema>,
): Promise<ActionResult<{ sessionsRevoked: number; alreadyDisabled: boolean }>> {
  const parsed = disableSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === 'reason') {
      // A deeper path means a specific complaint worth showing verbatim (the
      // "notes required for Other" rule, the 500-character cap). A bare
      // ['reason'] is just "missing", where the canonical sentence reads better.
      const message =
        issue.path.length > 1
          ? issue.message
          : DISABLE_CODE_RESULTS.ACCOUNT_DISABLE_REASON_REQUIRED.message;
      return err('validation_error', message, { code: 'ACCOUNT_DISABLE_REASON_REQUIRED' });
    }
    return err('validation_error', 'Invalid user id');
  }

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return err('forbidden', 'Not authorized.', {
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      ...(gate.reason === 'aal2_required' ? { reason: 'aal2_required' } : {}),
    });
  }

  const res = await disableUserAccount({
    targetUserId: parsed.data.targetUserId,
    reason: parsed.data.reason,
    actorUserId: gate.session.userId,
  });

  if (!res.ok) return accountStatusFailure(res.code);

  if (res.partial) {
    // Layer A landed, so the account is already locked out of every page and
    // API route. Say exactly that, then say what (if anything) fixes the rest.
    return partialFailure({
      lede: 'The account is flagged as disabled',
      retryHint: 'Press Disable again to complete it.',
      unretryableHint: 'The account stays disabled; retrying cannot recreate the missing record.',
      code: 'ACCOUNT_TEMPORARILY_DISABLED',
      reasons: res.partialReasons,
    });
  }

  return ok({ sessionsRevoked: res.sessionsRevoked, alreadyDisabled: res.alreadyDisabled });
}

/**
 * Platform-admin action: lift a temporary disable. Step-up gated because it
 * GRANTS access — the impersonation precedent leaves only access-REMOVING
 * actions un-gated.
 */
export async function reenableUserAccountAction(
  input: z.infer<typeof reenableSchema>,
): Promise<ActionResult<{ alreadyActive: boolean }>> {
  const parsed = reenableSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid user id');

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  if (!gate.ok) {
    return err('forbidden', 'Not authorized.', {
      code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED',
      ...(gate.reason === 'aal2_required' ? { reason: 'aal2_required' } : {}),
    });
  }

  const res = await reenableUserAccount({
    targetUserId: parsed.data.targetUserId,
    actorUserId: gate.session.userId,
  });

  if (!res.ok) return accountStatusFailure(res.code);

  if (res.partial) {
    return partialFailure({
      lede: 'The disable flag was cleared',
      retryHint: 'Press Re-enable again to finish.',
      unretryableHint: 'The account stays active; retrying cannot recreate the missing record.',
      code: 'ACCOUNT_NOT_DISABLED',
      reasons: res.partialReasons,
    });
  }

  return ok({ alreadyActive: res.alreadyActive });
}
