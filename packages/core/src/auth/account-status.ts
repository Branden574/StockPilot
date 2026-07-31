import { z } from 'zod';

/**
 * Shared vocabulary for the god-admin temporary account disable.
 *
 * This module is PURE (zod only, no platform imports) so the web server, the
 * web client and the Expo app all read ONE definition of the codes, the
 * user-facing sentences and the reason rules. The copy in particular must never
 * be retyped anywhere: it is owner-approved wording and it deliberately reveals
 * nothing about why the account was disabled or who did it.
 */

/**
 * Machine-readable sub-codes. These ride in `details.code` on an ActionResult /
 * ServiceError (the repo's existing convention) rather than becoming top-level
 * transport codes: `/api/v1` deliberately answers a disabled caller with the
 * same uniform 401 every unauthenticated caller gets, so an API probe teaches
 * an attacker nothing. Mobile derives ACCOUNT_TEMPORARILY_DISABLED locally from
 * its auth probe instead of being told by the server.
 *
 * ACCOUNT_NOT_FOUND is not in the original brief's list; it exists because
 * `auth.admin.getUserById` can legitimately miss (a user deleted between the
 * page render and the click) and that must not be reported as a disable
 * failure.
 */
export const ACCOUNT_DISABLE_CODES = [
  /** The caller's own account is disabled — the enforcement outcome. */
  'ACCOUNT_TEMPORARILY_DISABLED',
  /** Disable was requested for an account that is already disabled (no-op). */
  'ACCOUNT_ALREADY_DISABLED',
  /** Re-enable was requested for an account that is not disabled (no-op). */
  'ACCOUNT_NOT_DISABLED',
  /** The caller is not a platform admin, or the step-up has gone stale. */
  'ACCOUNT_DISABLE_NOT_AUTHORIZED',
  /** The target is on the platform-admin allowlist and can never be disabled. */
  'PROTECTED_ADMIN_ACCOUNT',
  /** A reason is mandatory on every disable. */
  'ACCOUNT_DISABLE_REASON_REQUIRED',
  /** No auth user with that id. */
  'ACCOUNT_NOT_FOUND',
  /**
   * The compare-and-set write was lost — a serialization failure, a deadlock or
   * another admin moving the same account at the same moment. Deliberately NOT
   * folded into ACCOUNT_DISABLE_NOT_AUTHORIZED: the actor's permission was
   * already verified before the write, so reusing that code would tell a god
   * admin they lack permission when someone else simply won the race. The
   * surface renders "this account's status just changed — reload and retry".
   */
  'ACCOUNT_STATUS_CHANGED',
] as const;
export type AccountDisableCode = (typeof ACCOUNT_DISABLE_CODES)[number];

/**
 * Observability event names for blocked traffic. These are structured
 * breadcrumbs (error-reporter tags / the existing user.sign_in_failed reason),
 * NOT new org-visible `audit_logs` events: whether an org may see that one of
 * its members was disabled by the platform is an OPEN policy question and must
 * not be answered by an implementation detail.
 */
export const DISABLED_ACCOUNT_EVENTS = {
  loginBlocked: 'DISABLED_ACCOUNT_LOGIN_BLOCKED',
  requestBlocked: 'DISABLED_ACCOUNT_REQUEST_BLOCKED',
} as const;

/** Web route for the blocked-route screen. Mobile renders the same copy. */
export const ACCOUNT_DISABLED_PATH = '/account-disabled';

/** Owner-approved wording. Do not paraphrase, shorten or localize in place. */
export const ACCOUNT_DISABLED_TITLE = 'Your account has been temporarily disabled';
export const ACCOUNT_DISABLED_MESSAGE =
  'Your StockPilot account has been temporarily disabled. Please contact your system administrator for assistance.';

/** Reason taxonomy shown in the confirm dialog. `other` requires free text. */
export const DISABLE_REASON_CATEGORIES = [
  'security_investigation',
  'offboarding_in_progress',
  'suspected_compromise',
  'policy_violation',
  'customer_request',
  'other',
] as const;
export type DisableReasonCategory = (typeof DISABLE_REASON_CATEGORIES)[number];

export const DISABLE_REASON_CATEGORY_LABELS: Record<DisableReasonCategory, string> = {
  security_investigation: 'Security investigation',
  offboarding_in_progress: 'Offboarding in progress',
  suspected_compromise: 'Suspected account compromise',
  policy_violation: 'Policy violation',
  customer_request: 'Customer request',
  other: 'Other',
};

/**
 * A reason is MANDATORY on every disable (owner requirement). The category is
 * always required; notes are required only for `other`, where the category
 * alone carries no information. Both the dialog and the server action parse
 * with this exact schema, so a payload valid on one is valid on the other.
 */
export const disableReasonSchema = z
  .object({
    category: z.enum(DISABLE_REASON_CATEGORIES),
    notes: z.string().max(500, 'Keep the note under 500 characters.').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.category !== 'other') return;
    if (!value.notes || value.notes.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message: 'Describe the reason when the category is Other.',
      });
    }
  });
export type DisableReasonInput = z.infer<typeof disableReasonSchema>;

/**
 * Flattens the structured reason into the single `user_profiles.disabled_reason`
 * text column. Composed on the SERVER so the stored string always matches the
 * taxonomy, whatever a client sends.
 */
export function composeDisabledReason(input: DisableReasonInput): string {
  const label = DISABLE_REASON_CATEGORY_LABELS[input.category];
  const notes = input.notes?.trim() ?? '';
  return notes.length > 0 ? `${label} — ${notes}` : label;
}

/**
 * The ONE predicate for "is this account disabled". Any non-blank timestamp
 * means disabled — including a future one, because a clock-skewed or
 * hand-written value must fail CLOSED, never open. A missing row (a user with
 * no profile) is treated as ACTIVE: absence of a profile is an onboarding
 * state, not a disable, and the membership checks already handle it.
 */
export function isAccountDisabled(
  profile: { disabled_at?: string | null } | null | undefined,
): boolean {
  const at = profile?.disabled_at;
  if (typeof at !== 'string') return false;
  return at.trim().length > 0;
}
