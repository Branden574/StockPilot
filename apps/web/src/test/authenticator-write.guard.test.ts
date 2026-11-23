import * as fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCallGraph,
  shippedSourceFiles,
  type CallGraph,
  type ReachFile,
  type WriteVerdict,
} from './gate-reach';

/**
 * Security invariant: when an organization's policy requires an authenticator
 * and the session has not satisfied it (`ctx.mfaRequired && !ctx.mfaSatisfied`),
 * every change to organization data gives the authenticator answer
 * (mfaGateError, server/services/context.ts) before its first write.
 *
 * The answer comes from assertPermission, assertAnyPermission or
 * assertCurrentAal2, or from the policy test written out
 * (`if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx)`). It is
 * never in withContext() or withApiContext(): reads under the set-up banner,
 * the Security page and every personal entry build the same context.
 *
 * Read on the syntax tree (test/gate-reach.ts, writeGate: what counts as a
 * write and as a gate is set out there), over three kinds of entry:
 *
 *   1. every name a 'use server' module exports (a Server Action), every
 *      POST, PUT, PATCH and DELETE handler of a route under app/api/v1, and
 *      every method of an exported class, every function of an exported
 *      object of functions and every exported function under server/services.
 *      Each one that writes passes a gate unconditionally before its first
 *      write, or is listed in REVIEWED with its kind, a reason and the writes
 *      it makes. A gate that sits inside a condition is named in the report.
 *      An export this reading cannot read as one function is reported by
 *      name, listed or not, and so is an entry that calls a collaborator this
 *      reading cannot follow, unless a person read it (RESOLVED_BY_READING);
 *   2. every listed entry is current: it exists, it writes, it still has a
 *      write before any gate (one that is gated leaves the list), it writes
 *      exactly what it pins (a new write fails until it is pinned), it gives a
 *      reason, a 'platform' entry reaches a platform-admin gate (or is a
 *      function of server/services/platform), a 'portal' entry reaches
 *      resolvePortalContext() (or is a function of server/services/portal.ts),
 *      a 'public' entry builds no member context, a 'link-or-member' entry
 *      gives the answer on its member branch (a gate inside a condition), and
 *      'system' and 'internal' entries are service functions or methods;
 *   3. the gates are where this guard thinks they are: assertPermission and
 *      assertAnyPermission give mfaGateError's answer on the policy test,
 *      withContext() and withApiContext() are no gate, and NOT_WRITES name
 *      functions that exist;
 *   4. an RPC counts as a read only when its latest definition in
 *      supabase/migrations is STABLE or IMMUTABLE (Postgres refuses a write
 *      statement in such a function's own body); every other RPC is a write;
 *   5. a mutation table: each gate in MUTATIONS, taken out of the real source
 *      one at a time, is reported for the entries it holds.
 *
 * The self-test at the bottom plants one of each shape, so this cannot pass
 * by reading nothing.
 *
 * WHEN THIS FAILS. Each line names the entry and, for a write, the line that
 * writes and how it is reached.
 *   - A new method, action or handler that changes organization data: give
 *     the answer before its first write. Call assertPermission (or
 *     assertAnyPermission) with the permission it needs, or, where no
 *     permission fits, write the policy test out as its first statement:
 *     `if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx);`.
 *   - An entry renamed or moved ("no such entry"): move its REVIEWED or
 *     MUTATIONS row to the new name. A listed entry that now gives the answer
 *     ("leaves the list"): delete its row.
 *   - A listed entry that writes something new ("does not pin"): if the new
 *     write is still the person's own (or the kind's), add it to `writes`;
 *     if it changes organization data, give the answer before it instead.
 *     When a shared helper (the audit writer, the event dispatcher) changes
 *     what it writes, every listed entry that reaches it fails at once: run
 *     this file with AUTHENTICATOR_GUARD_PRINT_PINS=1 to print the current
 *     `writes` of every listed entry, check the new labels, and copy them in.
 *     Printing changes no result.
 *   - A new RPC that only reads, reported as a write: declare it STABLE (or
 *     IMMUTABLE) in its migration. A function that writes must not be.
 *   - A new entry that is the person's own (a preference, a session, a sign-in
 *     step): list it in REVIEWED with the kind that fits, a reason of what it
 *     writes and why the policy does not apply, and the writes it makes, as
 *     the failure prints them.
 *   - A collaborator this guard cannot follow: give the field a default it can
 *     name (`deps.x ?? new X(ctx)`), or read it and list the entry in
 *     RESOLVED_BY_READING with what it writes and where the answer is given.
 */

const WEB_SRC = path.resolve(__dirname, '..');
const MIGRATIONS = path.resolve(WEB_SRC, '../../../supabase/migrations');

const CONTEXT = 'server/services/context.ts';
const GATES = [
  `${CONTEXT}#assertPermission`,
  `${CONTEXT}#assertAnyPermission`,
  `${CONTEXT}#assertCurrentAal2`,
];
const PLATFORM_GATES = [
  'lib/auth/platform-admin.ts#checkPlatformAdmin',
  'lib/auth/platform-admin.ts#currentUserIsPlatformAdmin',
];
const PORTAL_GATE = 'server/services/portal.ts#resolvePortalContext';
const MEMBER_CONTEXTS = [
  `${CONTEXT}#withContext`,
  'lib/auth/session.ts#requireOrgContext',
  'lib/auth/api-context.ts#withApiContext',
];

/** Functions read as writing nothing, each with why: no organization's data. */
const NOT_WRITES: Record<string, string> = {
  'lib/rate-limit.ts#checkRateLimit':
    "Counts the caller's own requests in the rate-limit table: bookkeeping about the request, not organization data.",
  'lib/books/lookup.ts#writeBookCache':
    'The shared ISBN cache: book facts from public sources, held for every organization alike, no organization data.',
  'server/security/events.ts#recordSecurityEvent':
    'Counts a refused or flagged request in the security-events record: bookkeeping about the request, in fixed words the server chooses, stored through the service-role-only writer. Nothing a member owns or typed is written.',
};

const ROUTE_WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

type Kind =
  /** Signing in or out, a password reset, accepting an invitation: before or outside any membership's policy. */
  | 'sign-in'
  /** Setting up the authenticator or its recovery codes: what the policy asks the person to do. */
  | 'set-up'
  /** The person's own account: password, email, deleting it. Each asks its own rule. */
  | 'own-account'
  /** The caller's own preferences, sessions, notifications, views, devices, read markers, tour, default organization or support request. */
  | 'personal'
  /** The platform console. */
  | 'platform'
  /** The customer portal, which applies the step-up rule itself. */
  | 'portal'
  /** No member session: a public form, a token link, a webhook. */
  | 'public'
  /** A public link handler that also serves members, and answers the member on their own branch. */
  | 'link-or-member'
  /** Scheduled jobs and the service-role pipeline (service functions only). */
  | 'system'
  /** A service helper whose callers give the answer before they call it (service functions only). */
  | 'internal';

interface Reviewed {
  kind: Kind;
  reason: string;
  /**
   * Every write the entry makes that no gate holds (WriteVerdict.writeSet):
   * a write it gains that is not pinned here is reported.
   */
  writes: readonly string[];
}

const PERSONAL_PREFS = "The caller's own preferences row; no organization data.";
const OWN_SESSIONS =
  "The caller's own sign-in sessions; a person under the policy must be able to end them.";
const PORTAL =
  'The customer portal: resolvePortalContext() comes first and applies the step-up rule to a portal account itself.';
const PLATFORM_CONSOLE =
  "The platform console: checkPlatformAdmin({ requireStepUp: true }) answers first, on the platform admin's own session.";
const PLATFORM_SERVICE =
  'Called only by the platform console actions, after checkPlatformAdmin answered (server/actions/platform*).';
const NOTIFY_HELPER =
  'Writes the in-app notifications a gated step sends; every caller is a change that has already given the answer.';

/** `<src-relative module>#<export>` or `<src-relative module>#<Class>.<method>`. */
const REVIEWED: Record<string, Reviewed> = {
  // ── signing in ──
  'server/actions/auth.ts#signInAction': {
    kind: 'sign-in',
    reason: 'Creates the session from the password; a failed attempt writes its audit row.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'sign_in_alerts.insert',
      'user_login_devices.delete',
      'user_login_devices.insert',
      'user_login_devices.update',
      'user_sign_in_countries.delete',
      'user_sign_in_countries.insert',
      'user_sign_in_countries.update',
    ],
  },
  'server/actions/auth.ts#signOutAction': {
    kind: 'sign-in',
    reason: 'Ends the session, which anyone must be able to do, whatever the policy.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:admin_revoke_user_sessions'],
  },
  'server/actions/auth.ts#requestPasswordResetAction': {
    kind: 'sign-in',
    reason: 'Public by design: one answer for every address, limited per IP and address.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'server/actions/auth.ts#completePasswordResetAction': {
    kind: 'sign-in',
    reason:
      "Sets the new password on the recovery session the emailed link created; asks an enrolled account for its code, or its passkey (stage 5): the passkey's answer spends its challenge, stores the passkey's use (counter, time) and writes the required raise row and the use row. It never seals a bridge again.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'member_passkeys.update',
      'rpc:admin_revoke_user_sessions',
      'rpc:take_passkey_challenge',
    ],
  },
  'server/actions/team.ts#acceptInviteAction': {
    kind: 'sign-in',
    reason:
      'Joins the organization a single-use invitation names; the membership the policy covers starts here.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'organization_invites.update',
      'organization_members.upsert',
      'user_profiles.update',
      'user_warehouse_assignments.insert',
    ],
  },
  'server/actions/team.ts#acceptInviteWithSignupAction': {
    kind: 'sign-in',
    reason: 'Creates the invited account and joins it: a new account has no authenticator yet.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.createUser',
      'organization_invites.update',
      'organization_members.upsert',
      'user_profiles.update',
      'user_profiles.upsert',
      'user_warehouse_assignments.insert',
    ],
  },
  'app/api/v1/auth/password-reset/route.ts#POST': {
    kind: 'sign-in',
    reason: "The phone's password reset request: public by design, one answer for every address.",
    writes: ['auth.admin.generateLink'],
  },
  'app/api/v1/auth/signed-in/route.ts#POST': {
    kind: 'sign-in',
    reason: "The phone's sign-in bookkeeping: one audit row that the person signed in.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'sign_in_alerts.insert',
      'user_login_devices.delete',
      'user_login_devices.insert',
      'user_login_devices.update',
      'user_sign_in_countries.delete',
      'user_sign_in_countries.insert',
      'user_sign_in_countries.update',
    ],
  },
  'app/api/v1/auth/signed-out/route.ts#POST': {
    kind: 'sign-in',
    reason: "The phone's sign-out: ends the person's own other sessions when asked.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:revoke_my_other_sessions'],
  },
  'server/services/team.ts#acceptInviteWithToken': {
    kind: 'sign-in',
    reason:
      'The invitation acceptance the two accept actions share: marks a single-use invitation used.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'organization_invites.update',
      'organization_members.upsert',
      'user_profiles.update',
      'user_warehouse_assignments.insert',
    ],
  },
  'server/services/auth-audit.ts#emitAuthAudit': {
    kind: 'sign-in',
    reason:
      'Audit rows for sign-in events (signed in, failed, code checked), written whatever the policy.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },

  // ── setting up the authenticator ──
  'server/actions/mfa.ts#challengeFactorAction': {
    kind: 'set-up',
    reason:
      'Checks the authenticator code: the step that satisfies the policy. It writes its audit row.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },
  'server/actions/mfa.ts#verifyEnrollmentAction': {
    kind: 'set-up',
    reason:
      'Confirms a first authenticator: exactly what the policy asks of a person who has none.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },
  'server/actions/mfa-recovery.ts#consumeMfaRecoveryCodeAction': {
    kind: 'set-up',
    reason:
      'The recovery code on the code page, for a person without their authenticator; password and rate limit.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.mfa.deleteFactor',
      'rpc:consume_mfa_recovery_code',
      'rpc:consume_recovery_code_with_passkeys',
      'rpc:passkey_remove_all',
      // Stage 5 (answers Q6): a used code ends the account's other sessions;
      // when Auth's sign-out of them fails, the database ends them, as the
      // member, keeping this session.
      'rpc:revoke_my_other_sessions',
    ],
  },
  'server/actions/mfa-recovery.ts#generateMfaRecoveryCodesAction': {
    kind: 'set-up',
    reason:
      "The caller's own recovery codes, per account, on a verified aal2 token (its own rule).",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:generate_mfa_recovery_codes'],
  },

  // Passkeys (stage 4, server/security/passkeys.ts): the second step a
  // policy asks for, and the caller's own passkeys. Each reads the account
  // from the verified token. Adding needs the site, the key, both passkey
  // switches and every organization of the member; the second step (and a
  // repair) the site, the key and the platform switch; listing, renaming and
  // removing one's own passkeys the site and an aal2 session (decision A).
  'server/actions/passkeys.ts#startSecondStepAction': {
    kind: 'sign-in',
    reason:
      "The passkey prompt: a one-use challenge for this account and session. When the account's state is a removal the member started and the session signed in with the password (never one an emailed link opened), it finishes it instead (the bridge factor at Auth, then its row); the only start that can.",
    writes: [
      'auth.admin.mfa.deleteFactor',
      'rpc:issue_passkey_challenge',
      'rpc:passkey_drop_bridge',
    ],
  },
  'server/actions/passkeys.ts#finishSecondStepAction': {
    kind: 'sign-in',
    reason:
      "The passkey answer: spends its challenge, stores the passkey's use (counter, time), writes the required raise row and the use row, and seals the bridge again when a newer key exists.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'member_passkeys.update',
      'rpc:passkey_replace_bridge',
      'rpc:take_passkey_challenge',
    ],
  },
  // Stage 5: the password reset's passkey prompt.
  'server/actions/passkeys.ts#startPasswordResetPasskeyAction': {
    kind: 'sign-in',
    reason:
      "The password reset's passkey prompt, on a session an emailed link opened within the hour: a one-use challenge for this account, this session and the reset, nothing else. It never finishes a removal (only the second step's start does).",
    writes: ['rpc:issue_passkey_challenge'],
  },
  'server/actions/passkeys.ts#startConfirmAddAction': {
    kind: 'set-up',
    reason:
      "The prompt a member with a passkey answers before adding another: a one-use challenge, nothing else (only the second step's start finishes a removal the member started).",
    writes: ['rpc:issue_passkey_challenge'],
  },
  'server/actions/passkeys.ts#startAddPasskeyAction': {
    kind: 'set-up',
    reason:
      "Starts adding a passkey: checks the proof (password, app code, or a passkey answer that stores its use), writes the code check's audit row, deletes the account's own leftover of a failed add (an unverified factor with the reserved name that no bridge row records; never a verified one), then a one-use challenge.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.mfa.deleteFactor',
      'member_passkeys.update',
      'rpc:issue_passkey_challenge',
      'rpc:take_passkey_challenge',
    ],
  },
  'server/actions/passkeys.ts#finishAddPasskeyAction': {
    kind: 'set-up',
    reason:
      "Stores the new passkey and, for a first one, its bridge, after deleting the account's own unverified leftover of a failed add (never a verified factor); a failed store or answer is undone in the same request (marked setup_failed, the new factor deleted).",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.mfa.deleteFactor',
      'rpc:passkey_mark_removed',
      'rpc:passkey_register',
      'rpc:take_passkey_challenge',
    ],
  },
  'server/actions/passkeys.ts#startPasskeySetupAction': {
    kind: 'set-up',
    reason:
      "The prompt for Finish setup: a one-use challenge, nothing else (only the second step's start finishes a removal the member started).",
    writes: ['rpc:issue_passkey_challenge'],
  },
  'server/actions/passkeys.ts#finishPasskeySetupAction': {
    kind: 'set-up',
    reason:
      'Finish setup: the passkey answer first, then a new bridge enrolled, answered and recorded in place of the old one; a factor it cannot record is deleted.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.mfa.deleteFactor',
      'member_passkeys.update',
      'rpc:passkey_replace_bridge',
      'rpc:take_passkey_challenge',
    ],
  },
  'server/actions/passkeys.ts#removePasskeyAction': {
    kind: 'own-account',
    reason:
      "Removes one of the caller's own passkeys on an aal2 session, unless it is the last second-step method a policy requires: the row marked removed, the bridge factor deleted with the last one, the other sessions ended.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.mfa.deleteFactor',
      'rpc:passkey_mark_removed',
      'rpc:revoke_my_other_sessions',
    ],
  },
  'server/actions/passkeys.ts#renamePasskeyAction': {
    kind: 'own-account',
    reason: "Renames one of the caller's own passkeys on an aal2 session.",
    writes: ['member_passkeys.update'],
  },

  // ── the person's own account ──
  'server/actions/auth.ts#changePasswordAction': {
    kind: 'own-account',
    reason:
      'Checks the current password and asks an account that has an authenticator for aal2 itself.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'rpc:admin_revoke_user_sessions',
      'rpc:revoke_my_other_sessions',
    ],
  },
  'server/actions/sign-in-alerts.ts#reportSignInAlertAction': {
    kind: 'own-account',
    reason:
      "The member's own sign-in alert, reported as not theirs: it ends every session of their account, marks the alert and forgets that account's device or country row. It also tells the owners and admins of the member's organizations once per alert (an in-app notice, which their phones are pushed, and an email, in fixed words) and writes an audit row in each of those organizations. It changes nothing else of any organization, and the worst it does to the account is end its sessions, so a session that still owes the authenticator step may do it.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'notifications.insert',
      'rpc:admin_revoke_user_sessions',
      'sign_in_alerts.update',
      'user_login_devices.delete',
      'user_sign_in_countries.delete',
    ],
  },
  'server/services/sign-in-alert-report.ts#reportSignInAlertNotMe': {
    kind: 'own-account',
    reason:
      "The not-me report itself, reached from the signed-in action above and from the alert email's signed link: the same writes, about the alert's own account, and the same telling of the owners and admins of that account's organizations once per alert (a notice, an email, an audit row in each organization).",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'notifications.insert',
      'rpc:admin_revoke_user_sessions',
      'sign_in_alerts.update',
      'user_login_devices.delete',
      'user_sign_in_countries.delete',
    ],
  },
  'server/actions/email-change.ts#requestEmailChangeAction': {
    kind: 'own-account',
    reason:
      "The caller's own email change; an enrolled account must be at aal2, and a member who must set up an authenticator first is refused (its own rule).",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'server/actions/email-change.ts#resendEmailChangeAction': {
    kind: 'own-account',
    reason: "Sends the caller's own pending email change again; same rules as requesting it.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'server/actions/email-change.ts#cancelEmailChangeAction': {
    kind: 'own-account',
    reason: "Withdraws the caller's own pending email change; returns no data.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:cancel_pending_email_change'],
  },
  'server/actions/profile.ts#deleteOwnAccountAction': {
    kind: 'own-account',
    reason:
      'Every member can delete their own account, whatever the organization requires: an account with an authenticator confirms at aal2, one with none with its password or the emailed code, checked before the first write and again right before the delete (server/lib/account-deletion-credential).',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.deleteUser',
      'rpc:account_deletion_check',
      'rpc:admin_revoke_user_sessions',
      'storage:user-avatars.remove',
    ],
  },
  'app/api/v1/account/delete/route.ts#POST': {
    kind: 'own-account',
    reason:
      "The phone's deletion of the caller's own account. With a password or the emailed code it applies the web's confirmation (an authenticator needs aal2; none needs the password or the code) and deletes whatever the organization requires; with neither it gives the organization policy's answer, as installed phones expect. The last check before the delete reads the account's factors again.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.deleteUser',
      'rpc:account_deletion_check',
      'rpc:admin_revoke_user_sessions',
      'storage:user-avatars.remove',
    ],
  },
  'app/api/v1/account/email/request/route.ts#POST': {
    kind: 'own-account',
    reason:
      "The phone's own email change; an enrolled account must be at aal2, and a member who must set up an authenticator first is refused (its own rule).",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'app/api/v1/account/email/resend/route.ts#POST': {
    kind: 'own-account',
    reason:
      "The phone's resend of the caller's own pending email change; same rules as requesting it.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'app/api/v1/account/email/cancel/route.ts#POST': {
    kind: 'own-account',
    reason: "The phone's cancel of the caller's own pending email change.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:cancel_pending_email_change'],
  },
  'server/services/email-change.ts#requestEmailChange': {
    kind: 'own-account',
    reason:
      'The email change the web and phone entries share, handed the account posture by its caller; it refuses a member who must set up an authenticator first before anything is spent.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'server/services/email-change.ts#resendEmailChange': {
    kind: 'own-account',
    reason:
      'The resend the web and phone entries share, handed the account posture by its caller; same refusals as the request.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'auth.admin.generateLink'],
  },
  'server/services/email-change.ts#cancelEmailChange': {
    kind: 'own-account',
    reason: "Withdraws the caller's own pending email change, for the web and phone entries.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:cancel_pending_email_change'],
  },
  'server/services/email-change.ts#completeEmailChange': {
    kind: 'own-account',
    reason: 'Runs when the emailed link is opened: copies the confirmed address onto the profile.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'user_profiles.update'],
  },
  'server/services/email-change.ts#mintEmailChangeLinks': {
    kind: 'own-account',
    reason:
      'Makes the two confirmation links of the caller own email change; its callers apply the rule.',
    writes: ['auth.admin.generateLink'],
  },
  'server/services/email-change.ts#reconcileProfileEmail': {
    kind: 'own-account',
    reason: "Copies the account's confirmed email onto its own profile row.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'user_profiles.update'],
  },

  // ── personal ──
  'server/actions/appearance.ts#setMyAppearanceAction': {
    kind: 'personal',
    reason:
      "Saves the caller's own Design and Theme; runs on every page, the sign-in pages included.",
    writes: ['user_appearance.upsert'],
  },
  'server/actions/digest.ts#setDigestOptinAction': {
    kind: 'personal',
    reason: PERSONAL_PREFS,
    writes: ['user_profiles.update'],
  },
  'server/actions/digest.ts#setDigestPrefsAction': {
    kind: 'personal',
    reason: PERSONAL_PREFS,
    writes: ['user_profiles.update'],
  },
  'server/actions/notification-preferences.ts#updateNotificationPreferencesAction': {
    kind: 'personal',
    reason: PERSONAL_PREFS,
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'notification_preferences.upsert'],
  },
  'server/services/notification-preferences.ts#writeDigestPrefs': {
    kind: 'personal',
    reason: PERSONAL_PREFS,
    writes: ['user_profiles.update'],
  },
  'server/services/notification-preferences.ts#writeNotificationPrefs': {
    kind: 'personal',
    reason: PERSONAL_PREFS,
    writes: ['notification_preferences.upsert'],
  },
  'server/actions/notifications.ts#markNotificationReadAction': {
    kind: 'personal',
    reason: "Marks one of the caller's own notifications read.",
    writes: ['notifications.update'],
  },
  'server/actions/notifications.ts#markAllNotificationsReadAction': {
    kind: 'personal',
    reason: "Marks the caller's own notifications read.",
    writes: ['notifications.update'],
  },
  'server/services/notifications.ts#NotificationsService.markRead': {
    kind: 'personal',
    reason: "Marks one of the caller's own notifications read.",
    writes: ['notifications.update'],
  },
  'server/services/notifications.ts#NotificationsService.markAllRead': {
    kind: 'personal',
    reason: "Marks the caller's own notifications read.",
    writes: ['notifications.update'],
  },
  'server/actions/sessions.ts#renameSessionAction': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['rpc:set_my_session_name'],
  },
  'server/actions/sessions.ts#revokeSessionAction': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:revoke_my_session'],
  },
  'server/actions/sessions.ts#revokeOtherSessionsAction': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:revoke_my_other_sessions'],
  },
  'server/services/sessions.ts#SessionsService.rename': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['rpc:set_my_session_name'],
  },
  'server/services/sessions.ts#SessionsService.revoke': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['rpc:revoke_my_session'],
  },
  'server/services/sessions.ts#SessionsService.revokeOthers': {
    kind: 'personal',
    reason: OWN_SESSIONS,
    writes: ['rpc:revoke_my_other_sessions'],
  },
  'server/actions/saved-views.ts#createSavedViewAction': {
    kind: 'personal',
    reason:
      "Saves the caller's own private list view; a shared one goes through SavedViewsService.createShared, which gives the answer.",
    writes: ['saved_views.insert'],
  },
  'server/actions/saved-views.ts#deleteSavedViewAction': {
    kind: 'personal',
    reason:
      "Deletes the caller's own private saved view; their own shared one goes through removeOwnShared and an admin's ownerless shared one through removeOwnerless, which give the answer.",
    writes: ['saved_views.delete'],
  },
  'server/services/saved-views.ts#SavedViewsService.create': {
    kind: 'personal',
    reason:
      "Saves the caller's own private list view; a shared one goes through createShared, which gives the answer.",
    writes: ['saved_views.insert'],
  },
  'server/services/saved-views.ts#SavedViewsService.remove': {
    kind: 'personal',
    reason:
      "Deletes the caller's own private saved view; their own shared one goes through removeOwnShared and an admin's ownerless shared one through removeOwnerless, which give the answer.",
    writes: ['saved_views.delete'],
  },
  'server/actions/org-switcher.ts#switchOrganizationAction': {
    kind: 'personal',
    reason:
      "The caller's own default organization: the person may need another organization's Security page.",
    writes: ['user_profiles.update'],
  },
  'server/actions/onboarding.ts#dismissOnboardingAction': {
    kind: 'personal',
    reason: "The caller's own onboarding banner state.",
    writes: ['user_profiles.update'],
  },
  'lib/onboarding/actions.ts#recordTourOutcomeAction': {
    kind: 'personal',
    reason: "The caller's own product-tour outcome (finished or skipped).",
    writes: ['user_onboarding.upsert'],
  },
  'server/actions/order-requests.ts#withdrawOrderSubmissionAction': {
    kind: 'personal',
    reason:
      "Settles the caller's own submission key (a placement that did not finish); placing is gated.",
    writes: ['rpc:withdraw_order_submission'],
  },
  'app/api/v1/orders/submissions/[key]/withdraw/route.ts#POST': {
    kind: 'personal',
    reason: "The phone's settle of the caller's own submission key; placing is gated.",
    writes: ['rpc:withdraw_order_submission'],
  },
  'server/services/order-requests.ts#OrderRequestsService.withdrawSubmission': {
    kind: 'personal',
    reason:
      "Settles the caller's own submission key, for the web and phone entries; placing is gated.",
    writes: ['rpc:withdraw_order_submission'],
  },
  'server/actions/support-tickets.ts#submitDashboardTicketAction': {
    kind: 'personal',
    reason:
      'A support request to the platform: a person held by the policy must still be able to ask for help.',
    writes: ['support_tickets.insert'],
  },
  'app/api/v1/support/route.ts#POST': {
    kind: 'personal',
    reason:
      "The phone's support request to the platform: a person held by the policy must be able to ask for help.",
    writes: ['support_tickets.insert'],
  },
  'app/api/v1/me/announcements/route.ts#POST': {
    kind: 'personal',
    reason: "The caller's own announcement read markers.",
    writes: ['user_onboarding.upsert'],
  },
  'app/api/v1/me/release-state/route.ts#POST': {
    kind: 'personal',
    reason: "The caller's own What's New read state, from the phone.",
    writes: ['rpc:record_release_state'],
  },
  'app/api/v1/me/seen/route.ts#POST': {
    kind: 'personal',
    reason: "The caller's own last-seen time in the organization.",
    writes: ['rpc:touch_member_last_seen'],
  },
  'server/services/releases.ts#recordReleaseState': {
    kind: 'personal',
    reason: "The caller's own What's New read state, for the web and phone entries.",
    writes: ['rpc:record_release_state'],
  },
  'app/api/v1/push/register/route.ts#POST': {
    kind: 'personal',
    reason: "Registers the caller's own device for push notifications.",
    writes: ['rpc:register_push_token'],
  },
  'app/api/v1/push/register/route.ts#DELETE': {
    kind: 'personal',
    reason: "Removes the caller's own device token on sign-out.",
    writes: ['push_tokens.delete'],
  },
  'app/api/v1/push/test/route.ts#POST': {
    kind: 'personal',
    reason:
      "Sends a test push to the caller's own devices (a token that no longer works is removed).",
    writes: ['push_tokens.delete'],
  },

  // ── the platform console ──
  'server/actions/organization.ts#createOrganizationAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'locations.insert',
      'organization_members.insert',
      'organizations.delete',
      'organizations.insert',
      'platform_admin_audit.insert',
      'user_profiles.update',
    ],
  },
  'server/actions/platform-admin.ts#createOrgForCustomerAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'auth.admin.generateLink',
      'locations.insert',
      'organization_members.insert',
      'organizations.delete',
      'organizations.insert',
      'platform_admin_audit.insert',
      'user_profiles.update',
      'user_profiles.upsert',
    ],
  },
  'server/actions/platform-admin.ts#removeOrgAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'auth.admin.deleteUser',
      'organizations.delete',
      'platform_admin_audit.insert',
      'rpc:account_deletion_check',
      'storage:user-avatars.remove',
    ],
  },
  'server/actions/platform-admin.ts#setOrgDeletionPassphraseAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['platform_admin_audit.insert', 'platform_settings.upsert'],
  },
  'server/actions/platform/billing.ts#setOrgBillingAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['organizations.update', 'platform_admin_audit.insert'],
  },
  'server/actions/platform/billing.ts#startOrgTrialAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['organizations.update', 'platform_admin_audit.insert'],
  },
  'server/actions/platform/impersonation.ts#startActingAsAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'organization_members.delete',
      'organization_members.upsert',
      'platform_admin_audit.insert',
      'platform_impersonation_sessions.insert',
      'platform_impersonation_sessions.update',
      'user_profiles.update',
    ],
  },
  'server/actions/platform/impersonation.ts#stopActingAsAction': {
    kind: 'platform',
    reason:
      "Ends the platform admin's own acting-as grant, which only removes access; currentUserIsPlatformAdmin answers first.",
    writes: [
      'organization_members.delete',
      'platform_admin_audit.insert',
      'platform_impersonation_sessions.update',
      'user_profiles.update',
    ],
  },
  'server/actions/platform/users.ts#disableUserAccountAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'auth.admin.updateUserById',
      'platform_admin_audit.insert',
      'rpc:admin_revoke_user_sessions',
      'user_profiles.update',
    ],
  },
  'server/actions/platform/users.ts#reenableUserAccountAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['auth.admin.updateUserById', 'platform_admin_audit.insert', 'user_profiles.update'],
  },
  'server/actions/platform/users.ts#sendUserPasswordResetAction': {
    kind: 'platform',
    reason:
      'Emails a password-reset link to an account, which changes nothing until its owner uses it; checkPlatformAdmin answers first.',
    writes: ['auth.admin.generateLink', 'platform_admin_audit.insert'],
  },
  'server/actions/support-tickets.ts#updateSupportTicketAction': {
    kind: 'platform',
    reason:
      "Triages a support ticket (status, priority, the platform's own notes); currentUserIsPlatformAdmin answers first.",
    writes: ['support_tickets.update'],
  },
  'server/actions/platform/passkeys.ts#setNewPasskeysSwitchAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['platform_admin_audit.insert', 'platform_settings.insert', 'platform_settings.update'],
  },
  'server/actions/platform/passkeys.ts#setOrganizationPasskeysAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: [
      'organization_passkey_switches.delete',
      'organization_passkey_switches.insert',
      'platform_admin_audit.insert',
    ],
  },
  'server/actions/platform/passkeys.ts#setPasskeysKillSwitchAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['platform_admin_audit.insert', 'platform_settings.insert', 'platform_settings.update'],
  },
  'server/actions/platform/permission-exceptions.ts#setOrderItemsAccessAction': {
    kind: 'platform',
    reason: PLATFORM_CONSOLE,
    writes: ['rpc:platform_set_permission_exception'],
  },
  'server/services/platform/permission-exceptions.ts#PermissionExceptionsService.set': {
    kind: 'platform',
    reason:
      'Called only by setOrderItemsAccessAction after checkPlatformAdmin answered; it checks the platform allowlist again itself.',
    writes: ['rpc:platform_set_permission_exception'],
  },
  'server/services/platform/account-status.ts#disableUserAccount': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: [
      'auth.admin.updateUserById',
      'platform_admin_audit.insert',
      'rpc:admin_revoke_user_sessions',
      'user_profiles.update',
    ],
  },
  'server/services/platform/account-status.ts#reenableUserAccount': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['auth.admin.updateUserById', 'platform_admin_audit.insert', 'user_profiles.update'],
  },
  'server/services/platform/audit.ts#recordPlatformAudit': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['platform_admin_audit.insert'],
  },
  'server/services/platform/billing.ts#setBilling': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['organizations.update', 'platform_admin_audit.insert'],
  },
  'server/services/platform/billing.ts#startTrial': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['organizations.update', 'platform_admin_audit.insert'],
  },
  'server/services/platform/impersonation.ts#startActingAs': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: [
      'organization_members.delete',
      'organization_members.upsert',
      'platform_admin_audit.insert',
      'platform_impersonation_sessions.insert',
      'platform_impersonation_sessions.update',
      'user_profiles.update',
    ],
  },
  'server/services/platform/impersonation.ts#stopActingAs': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: [
      'organization_members.delete',
      'platform_admin_audit.insert',
      'platform_impersonation_sessions.update',
      'user_profiles.update',
    ],
  },
  'server/services/platform/impersonation.ts#sweepExpiredImpersonations': {
    kind: 'platform',
    reason:
      'Ends temporary platform memberships past their end time; run by the console actions and a job.',
    writes: [
      'organization_members.delete',
      'platform_impersonation_sessions.update',
      'user_profiles.update',
    ],
  },
  'server/services/platform/sessions.ts#revokeAllSessionsForUser': {
    kind: 'platform',
    reason:
      'Ends every session of one account: the console, and the sign-out and password paths for the own account.',
    writes: ['rpc:admin_revoke_user_sessions'],
  },
  'server/services/platform/users.ts#sendPasswordResetForUser': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['auth.admin.generateLink', 'platform_admin_audit.insert'],
  },
  'server/services/support-tickets.ts#updateSupportTicket': {
    kind: 'platform',
    reason: PLATFORM_SERVICE,
    writes: ['support_tickets.update'],
  },

  // ── the customer portal ──
  'server/actions/portal.ts#submitPortalOrderAction': {
    kind: 'portal',
    reason: PORTAL,
    writes: [
      'customer_users.update',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'rpc:insert_order_request_with_lines',
    ],
  },
  'server/actions/portal.ts#requestPortalReturnAction': {
    kind: 'portal',
    reason: PORTAL,
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'customer_users.update',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'rpc:create_requester_return_request',
      'rpc:publish_outbox',
    ],
  },
  'server/actions/portal.ts#portalReturnSheetAction': {
    kind: 'portal',
    reason: PORTAL,
    writes: ['customer_users.update'],
  },
  'server/actions/portal.ts#portalReturnOptionsAction': {
    kind: 'portal',
    reason: PORTAL,
    writes: ['customer_users.update'],
  },
  'server/services/portal.ts#resolvePortalContext': {
    kind: 'portal',
    reason:
      "The portal's own funnel: it applies the step-up rule, then stamps the portal account accepted.",
    writes: ['customer_users.update'],
  },
  'server/services/portal.ts#portalSubmitOrder': {
    kind: 'portal',
    reason: PORTAL,
    writes: [
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'rpc:insert_order_request_with_lines',
    ],
  },
  'server/services/returns.ts#createPortalReturn': {
    kind: 'portal',
    reason: PORTAL,
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'rpc:create_requester_return_request',
      'rpc:publish_outbox',
    ],
  },

  // ── no member session ──
  'server/actions/support-tickets.ts#createSupportTicketAction': {
    kind: 'public',
    reason: 'The public support form: no session, limited per IP, written with the service client.',
    writes: ['support_tickets.insert'],
  },
  'server/services/support-tickets.ts#createSupportTicket': {
    kind: 'public',
    reason:
      'The support request both the public form and the members entries write; no organization data.',
    writes: ['support_tickets.insert'],
  },
  'app/api/v1/public/order-requests/route.ts#POST': {
    kind: 'public',
    reason: 'The public order link: no member session; the link token and its own limits decide.',
    writes: [
      'rpc:cleanup_expired_unconfirmed_order_requests',
      'rpc:insert_order_request_with_lines',
      'rpc:publish_outbox',
    ],
  },
  'app/api/v1/public/returns/route.ts#POST': {
    kind: 'public',
    reason: 'The public return link: no member session; the return token decides.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'rpc:create_requester_return_request',
      'rpc:publish_outbox',
    ],
  },
  'server/services/returns.ts#createRequesterReturn': {
    kind: 'public',
    reason: 'The return a token link holder files; no member session.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'rpc:create_requester_return_request',
      'rpc:publish_outbox',
    ],
  },
  'server/services/member-email-unsubscribe.ts#unsubscribeMemberEmail': {
    kind: 'public',
    reason:
      "The unsubscribe link in an email: a signed claim names the person; it turns that person's own digest off.",
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'notification_preferences.upsert',
      'user_profiles.update',
    ],
  },
  'server/services/delivery-tracking.ts#getPublicDriverLocation': {
    kind: 'public',
    reason:
      "The customer's tracking page: no member session; it keeps a geocode of the destination.",
    writes: ['charters.update'],
  },
  'app/api/v1/orders/sign/route.ts#POST': {
    kind: 'link-or-member',
    reason:
      'The signature link needs no member (the customer signs); the member branch gives the answer first.',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'delivery_locations.delete',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'order_requests.update',
      'rpc:confirm_order_signature',
      'rpc:order_return_token_ensure',
      'schedule_events.update',
    ],
  },

  // ── scheduled jobs and the pipeline ──
  'server/services/archive-cleanup.ts#purgeExpiredArchivedItems': {
    kind: 'system',
    reason:
      'The nightly clean-up of items archived past the retention window, under a system context.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'inventory_items.update'],
  },
  'server/services/auto-archive.ts#archiveExpiredZeroStockItems': {
    kind: 'system',
    reason: "The scheduled auto-archive of out-of-stock items, by each organization's own setting.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'inventory_items.update'],
  },
  'server/services/auto-archive.ts#notifyAutoArchived': {
    kind: 'system',
    reason: 'The notice the scheduled auto-archive sends.',
    writes: ['notifications.insert'],
  },
  'server/services/billing.ts#syncSubscriptionFromStripe': {
    kind: 'system',
    reason: "The billing webhook: the processor's signed event, no member session.",
    writes: ['organizations.update'],
  },
  'server/services/exception-occurrences.ts#ExceptionOccurrencesService.syncOrg': {
    kind: 'system',
    reason:
      'Recomputes the Exception Center for an organization with the service role, after gated changes and on a schedule.',
    writes: ['rpc:exceptions_sync'],
  },
  'server/services/lib/exception-sync-schedule.ts#scheduleExceptionSync': {
    kind: 'system',
    reason: 'Schedules that recompute after a gated change has been written.',
    writes: ['rpc:exceptions_sync'],
  },
  'server/services/integration-events.ts#drainIntegrationDeliveries': {
    kind: 'system',
    reason: 'The scheduled delivery of queued webhook events.',
    writes: ['integration_deliveries.update', 'integration_endpoints.update'],
  },
  'server/services/price-tracking.ts#refreshBookPricesForOrg': {
    kind: 'system',
    reason:
      'The scheduled price refresh, and the gated Refresh prices action, record public price observations.',
    writes: ['inventory_items.update', 'item_price_observations.insert'],
  },
  'server/services/price-tracking.ts#recordBookObservation': {
    kind: 'system',
    reason: 'One price observation written by the price refresh.',
    writes: ['inventory_items.update', 'item_price_observations.insert'],
  },
  'server/services/lib/cron-sweep.ts#cronAttemptRecorder': {
    kind: 'system',
    reason:
      'Records when a scheduled job (api/cron/exception-occurrences, api/cron/restore-points, the orders catalog prewarm job, and api/cron/weekly-digest through sweepOrganizations) last started each organization, and its attempts in a row without success, on the service-role client.',
    writes: ['cron_sweep_attempts.upsert'],
  },
  'server/services/lib/cron-sweep.ts#cronAttemptClaimer': {
    kind: 'system',
    reason:
      'Claims an organization for one run of a scheduled job (one per organization per hold) and records when it started, in the cron_sweep_attempts row of that job and organization, on the service-role client.',
    writes: [
      'cron_sweep_attempts.insert',
      'cron_sweep_attempts.update',
      'cron_sweep_attempts.upsert',
    ],
  },
  'server/services/lib/cron-sweep.ts#sweepOrganizations': {
    kind: 'system',
    reason:
      'The shared loop of the scheduled jobs that visit organizations one at a time; its only writes are their cron_sweep_attempts rows (cronAttemptRecorder, cronAttemptClaimer). Each organization is then worked by the job under its own system context.',
    writes: [
      'cron_sweep_attempts.insert',
      'cron_sweep_attempts.update',
      'cron_sweep_attempts.upsert',
    ],
  },
  'server/services/restore-points.ts#pruneSnapshots': {
    kind: 'system',
    reason: 'The nightly prune of restore points past their keep window.',
    writes: ['restore_points.delete'],
  },
  'server/services/shipping.ts#ShippingService.reapStuckShipment': {
    kind: 'system',
    reason:
      'The scheduled job that settles a label purchase left unfinished (api/cron/reap-stuck-shipments).',
    writes: ['carrier_shipments.update', 'rpc:connector_secret_get'],
  },

  // ── helpers its callers gate ──
  'server/services/audit.ts#audit': {
    kind: 'internal',
    reason: 'Writes the audit row of an act; the act decided whether it was allowed.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },
  'server/services/audit.ts#auditMany': {
    kind: 'internal',
    reason:
      'Writes the audit rows of an act over a selection; the act decided whether it was allowed.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },
  'server/services/audit.ts#insertAuditRowReported': {
    kind: 'internal',
    reason: 'Writes one prepared audit row; its callers decided whether the act was allowed.',
    writes: ['audit_logs.insert', 'audit_logs.upsert'],
  },
  'server/services/notifications.ts#createNotification': {
    kind: 'internal',
    reason: NOTIFY_HELPER,
    writes: ['notifications.insert'],
  },
  'server/services/maintenance-notify.ts#notifyMaintenanceEvent': {
    kind: 'internal',
    reason: NOTIFY_HELPER,
    writes: ['notifications.insert'],
  },
  'server/services/returns-notify.ts#notifyRequesterReturnEvent': {
    kind: 'internal',
    reason: NOTIFY_HELPER,
    writes: ['notifications.insert'],
  },
  'server/services/returns-notify.ts#notifyStaffNewReturnRequest': {
    kind: 'internal',
    reason: NOTIFY_HELPER,
    writes: ['notifications.insert'],
  },
  'server/services/push.ts#notifyUser': {
    kind: 'internal',
    reason:
      'Sends a push a gated step (or the caller to their own devices) asked for; removes tokens that no longer work.',
    writes: ['push_tokens.delete'],
  },
  'server/services/integration-events.ts#dispatchEvent': {
    kind: 'internal',
    reason:
      'Queues the webhook events of a change that has already been written behind its own gate.',
    writes: [
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
    ],
  },
  'server/services/order-requests.ts#syncOrderScheduleEvent': {
    kind: 'internal',
    reason:
      "Moves an order's calendar entry after a gated order step (or the signature link) changed the order.",
    writes: ['schedule_events.update'],
  },
  'server/services/opening-stock-compensation.ts#compensateOpeningStockOrThrow': {
    kind: 'internal',
    reason:
      'Undoes the opening stock of a create that failed half way; its callers are gated creates.',
    writes: ['rpc:compensate_opening_stock'],
  },
  'server/services/po-imports-lines.ts#createItemsFromPoLines': {
    kind: 'internal',
    reason:
      'Creates items for the lines of a PO import; its one caller (PoImportsService) asks its permission first.',
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'po_import_lines.update'],
  },
  'server/services/returns.ts#createMemberReturn': {
    kind: 'internal',
    reason:
      'Files the return a member asks for; its route gives the answer first (api/v1/orders/[id]/return-request).',
    writes: [
      'audit_logs.insert',
      'audit_logs.upsert',
      'integration_deliveries.update',
      'integration_deliveries.upsert',
      'integration_endpoints.update',
      'notifications.insert',
      'rpc:create_requester_return_request',
      'rpc:publish_outbox',
    ],
  },
  'server/services/inventory.ts#InventoryService.stampPlacementBin': {
    kind: 'internal',
    reason: 'Stamps the rack label after a gated transfer or put-away moved the stock.',
    writes: ['rpc:inventory_set_bin_location', 'rpc:inventory_set_rack'],
  },
  'server/services/inventory.ts#InventoryService.syncBookCratePlacement': {
    kind: 'internal',
    reason: "Reconciles a book's crate label after a gated transfer or put-away moved the stock.",
    writes: ['audit_logs.insert', 'audit_logs.upsert', 'rpc:inventory_set_book_placement'],
  },
  'server/services/item-imports.ts#ItemImportBatchesService.claim': {
    kind: 'internal',
    reason:
      'Claims an import batch for the import action, which asks its permission before it calls this.',
    writes: ['item_import_batches.insert', 'item_import_batches.update'],
  },
  'server/services/item-imports.ts#ItemImportBatchesService.recordOutcome': {
    kind: 'internal',
    reason: 'Records the outcome of an import batch, for the import action, after its gate.',
    writes: ['item_import_batches.update'],
  },
  'server/services/item-imports.ts#ItemImportBatchesService.release': {
    kind: 'internal',
    reason: 'Releases a claimed import batch, for the import action, after its gate.',
    writes: ['item_import_batches.update'],
  },
  'server/services/delivery-tracking.ts#DeliveryTrackingService.purgeForOrder': {
    kind: 'internal',
    reason:
      'Deletes the live point of an order that left in_transit; a clean-up for the order step that calls it.',
    writes: ['delivery_locations.delete'],
  },
};

/**
 * Entries that call a collaborator this guard cannot follow (WriteVerdict
 * .unresolved: a value a class is handed, with no default this reading can
 * name), each read by a person: `<entry>: what it writes through them and
 * where the answer is given`. Empty on the real tree: every collaborator in it
 * is followed (a field given `deps.x ?? new X(ctx)` or `deps.f ?? f`, and an
 * object of functions, `export const S = { set, list }`).
 */
const RESOLVED_BY_READING: Record<string, string> = {};

/**
 * The gates this rule holds, each taken out of the real source in turn: the
 * first `remove` after `anchor` in `file`. `expect` names entries that must
 * then be reported; `conditional` names a gate the report must then name as
 * sitting inside a condition.
 */
interface Mutation {
  file: string;
  anchor: string;
  remove: string;
  expect: string[];
  conditional?: string;
}
const SERVICE_GATE =
  'if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) throw mfaGateError(this.ctx);';
const ACTION_GATE = 'if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx);';
const ORDERS = 'server/services/order-requests.ts';
const MAINTENANCE = 'server/services/maintenance-requests.ts';
const SAVED_VIEWS = 'server/services/saved-views.ts';
const MUTATIONS: Mutation[] = [
  {
    file: 'server/services/api-keys.ts',
    anchor: 'private gateChange() {',
    remove: SERVICE_GATE,
    expect: [
      'server/services/api-keys.ts#ApiKeysService.create',
      'server/services/api-keys.ts#ApiKeysService.revoke',
      'server/actions/api-keys.ts#createApiKeyAction',
      'server/actions/api-keys.ts#revokeApiKeyAction',
    ],
  },
  {
    file: 'server/actions/team.ts',
    anchor: 'export async function transferOwnershipAction(',
    remove: ACTION_GATE,
    expect: ['server/actions/team.ts#transferOwnershipAction'],
    conditional: 'assertCurrentAal2(ctx)',
  },
  {
    file: ORDERS,
    anchor: 'async addLines(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.addLines`,
      'server/actions/order-requests.ts#addOrderRequestLinesAction',
      'app/api/v1/orders/[id]/lines/route.ts#POST',
    ],
  },
  {
    file: ORDERS,
    anchor: 'async updateLineQuantity(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.updateLineQuantity`,
      'server/actions/order-requests.ts#updateOrderRequestLineQuantityAction',
      'app/api/v1/orders/[id]/lines/route.ts#PATCH',
    ],
  },
  {
    file: ORDERS,
    anchor: 'async removeLine(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.removeLine`,
      'server/actions/order-requests.ts#removeOrderRequestLineAction',
      'app/api/v1/orders/[id]/lines/route.ts#DELETE',
    ],
  },
  {
    file: ORDERS,
    anchor: 'async assignPicking(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.assignPicking`,
      'server/actions/order-requests.ts#assignPickingAction',
      'app/api/v1/orders/[id]/transition/route.ts#POST',
    ],
  },
  {
    file: ORDERS,
    anchor: 'async markInTransit(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.markInTransit`,
      'server/actions/order-requests.ts#markInTransitAction',
      'app/api/v1/orders/[id]/transition/route.ts#POST',
    ],
  },
  {
    file: ORDERS,
    anchor: 'async confirmPhysicalSignature(',
    remove: SERVICE_GATE,
    expect: [
      `${ORDERS}#OrderRequestsService.confirmPhysicalSignature`,
      'server/actions/order-requests.ts#confirmPhysicalSignatureAction',
      'app/api/v1/orders/[id]/transition/route.ts#POST',
    ],
  },
  {
    file: 'server/services/maintenance-share-links.ts',
    anchor: 'async issueLink(',
    remove: SERVICE_GATE,
    expect: [
      'server/services/maintenance-share-links.ts#MaintenanceShareLinksService.issueLink',
      'server/actions/maintenance-requests.ts#issueMaintenanceShareLinkAction',
      'app/api/v1/maintenance-requests/[id]/share-link/route.ts#POST',
    ],
    conditional: "assertPermission(this.ctx, 'maintenance_requests:manage')",
  },
  {
    file: MAINTENANCE,
    anchor: 'async update(id: string, patch: unknown)',
    remove: SERVICE_GATE,
    expect: [
      `${MAINTENANCE}#MaintenanceRequestsService.update`,
      'server/actions/maintenance-requests.ts#updateMaintenanceRequestAction',
      'app/api/v1/maintenance-requests/[id]/route.ts#PATCH',
    ],
  },
  {
    file: MAINTENANCE,
    anchor: 'async cancel(id: string)',
    remove: SERVICE_GATE,
    expect: [
      `${MAINTENANCE}#MaintenanceRequestsService.cancel`,
      'server/actions/maintenance-requests.ts#cancelMaintenanceRequestAction',
    ],
  },
  {
    file: MAINTENANCE,
    anchor: 'async recordDraftOpened(',
    remove: SERVICE_GATE,
    expect: [
      `${MAINTENANCE}#MaintenanceRequestsService.recordDraftOpened`,
      'server/actions/maintenance-requests.ts#recordMaintenanceDraftOpenedAction',
      'app/api/v1/maintenance-requests/[id]/draft-opened/route.ts#POST',
    ],
  },
  {
    file: 'server/services/order-attachments.ts',
    anchor: 'async add(input: {',
    remove: SERVICE_GATE,
    expect: [
      'server/services/order-attachments.ts#OrderAttachmentsService.add',
      'server/actions/order-attachments.ts#addOrderAttachmentAction',
      'app/api/v1/orders/[id]/attachments/route.ts#POST',
    ],
  },
  {
    file: 'server/services/order-attachments.ts',
    anchor: 'async remove(attachmentId: string)',
    remove: SERVICE_GATE,
    expect: [
      'server/services/order-attachments.ts#OrderAttachmentsService.remove',
      'server/actions/order-attachments.ts#deleteOrderAttachmentAction',
    ],
  },
  {
    file: 'server/services/cycle-counts.ts',
    anchor: 'async forceReassign(',
    remove: SERVICE_GATE,
    expect: [
      'server/services/cycle-counts.ts#CycleCountsService.forceReassign',
      'app/api/v1/cycle-counts/[id]/reassign/route.ts#POST',
    ],
  },
  {
    file: 'server/services/size-counts.ts',
    anchor: 'async deleteTrainingSample(',
    remove: SERVICE_GATE,
    expect: [
      'server/services/size-counts.ts#SizeCountsService.deleteTrainingSample',
      'app/api/v1/size-counts/training/samples/[id]/route.ts#DELETE',
    ],
  },
  {
    file: 'server/services/procedure-comments.ts',
    anchor: 'async update(id: string, input: UpdateProcedureCommentInput)',
    remove: SERVICE_GATE,
    expect: [
      'server/services/procedure-comments.ts#ProcedureCommentsService.update',
      'server/actions/procedures.ts#updateProcedureCommentAction',
    ],
  },
  {
    file: 'server/services/procedure-comments.ts',
    anchor: 'async delete(id: string)',
    remove: SERVICE_GATE,
    expect: [
      'server/services/procedure-comments.ts#ProcedureCommentsService.delete',
      'server/actions/procedures.ts#deleteProcedureCommentAction',
    ],
  },
  {
    file: 'server/actions/export-presets.ts',
    anchor: 'export async function saveSharedExportPresetAction(',
    remove: ACTION_GATE,
    expect: ['server/actions/export-presets.ts#saveSharedExportPresetAction'],
  },
  {
    file: 'server/actions/export-presets.ts',
    anchor: 'export async function deleteSharedExportPresetAction(',
    remove: ACTION_GATE,
    expect: ['server/actions/export-presets.ts#deleteSharedExportPresetAction'],
  },
  {
    file: 'server/services/books-import.ts',
    anchor: 'async backfillCovers(',
    remove: "assertPermission(this.ctx, 'items:create');",
    expect: [
      'server/services/books-import.ts#BooksImportService.backfillCovers',
      'server/actions/books-backfill-covers.ts#backfillBookCoversAction',
    ],
  },
  {
    file: 'server/services/delivery-tracking.ts',
    anchor: 'async shareLocation(',
    remove: SERVICE_GATE,
    expect: [
      'server/services/delivery-tracking.ts#DeliveryTrackingService.shareLocation',
      'server/actions/delivery-tracking.ts#shareDeliveryLocationAction',
      'app/api/v1/delivery/location/route.ts#POST',
    ],
  },
  {
    file: 'server/actions/inventory.ts',
    anchor: 'export async function bulkPlaceStockAction(',
    remove: ACTION_GATE,
    expect: ['server/actions/inventory.ts#bulkPlaceStockAction'],
    conditional: 'invSvc.transferStock(',
  },
  {
    file: SAVED_VIEWS,
    anchor: 'private gateOrganizationChange(): void {',
    remove: SERVICE_GATE,
    expect: [
      `${SAVED_VIEWS}#SavedViewsService.createShared`,
      `${SAVED_VIEWS}#SavedViewsService.setSharing`,
      `${SAVED_VIEWS}#SavedViewsService.removeOwnerless`,
      `${SAVED_VIEWS}#SavedViewsService.removeOwnShared`,
      'server/actions/saved-views.ts#toggleSavedViewShareAction',
    ],
  },
  {
    file: SAVED_VIEWS,
    anchor: 'async createShared(',
    remove: 'this.gateOrganizationChange();',
    expect: [`${SAVED_VIEWS}#SavedViewsService.createShared`],
  },
  {
    file: SAVED_VIEWS,
    anchor: 'async setSharing(',
    remove: 'this.gateOrganizationChange();',
    expect: [
      `${SAVED_VIEWS}#SavedViewsService.setSharing`,
      'server/actions/saved-views.ts#toggleSavedViewShareAction',
    ],
  },
  {
    file: SAVED_VIEWS,
    anchor: 'async removeOwnerless(',
    remove: 'this.gateOrganizationChange();',
    expect: [`${SAVED_VIEWS}#SavedViewsService.removeOwnerless`],
  },
  {
    file: SAVED_VIEWS,
    anchor: 'async removeOwnShared(',
    remove: 'this.gateOrganizationChange();',
    expect: [`${SAVED_VIEWS}#SavedViewsService.removeOwnShared`],
  },
  {
    file: 'server/actions/delivery-request.ts',
    anchor: 'export async function recordDeliveryRequestDraftedAction(',
    remove: 'if (ctx.mfaRequired && !ctx.mfaSatisfied) return;',
    expect: ['server/actions/delivery-request.ts#recordDeliveryRequestDraftedAction'],
  },
];

/* ───────────────────────────── the reading ───────────────────────────── */

interface Tree {
  graph: CallGraph;
  files: ReachFile[];
  abs: (rel: string) => string;
  rel: (abs: string) => string;
}

function treeOf(files: ReachFile[], srcRoot: string): Tree {
  return {
    graph: buildCallGraph(files, srcRoot),
    files,
    abs: (rel) => path.join(srcRoot, rel),
    rel: (abs) => path.relative(srcRoot, abs).split(path.sep).join('/'),
  };
}

const absKey = (tree: Tree, key: string) => {
  const at = key.indexOf('#');
  return `${tree.abs(key.slice(0, at))}#${key.slice(at + 1)}`;
};

/**
 * The RPCs whose latest definition is STABLE or IMMUTABLE: the volatility
 * written before the body (`... stable as $$`) or after it (`$$ language sql
 * stable;`). Overloads share one name; the latest definition decides.
 */
function readOnlyFunctions(files: Array<{ name: string; text: string }>): Set<string> {
  const latest = new Map<string, string>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi;
    for (let m = re.exec(f.text); m; m = re.exec(f.text)) {
      const rest = f.text.slice(m.index);
      const body = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(rest);
      if (!body) continue;
      const tag = body[1]!;
      const bodyStart = body.index + body[0].length;
      const bodyEnd = rest.indexOf(tag, bodyStart);
      if (bodyEnd < 0) continue;
      const tailEnd = rest.indexOf(';', bodyEnd + tag.length);
      const attributes = `${rest.slice(0, body.index)} ${rest.slice(bodyEnd + tag.length, tailEnd < 0 ? undefined : tailEnd)}`;
      latest.set(m[1]!.toLowerCase(), attributes);
    }
  }
  return new Set(
    [...latest].filter(([, attrs]) => /\b(stable|immutable)\b/i.test(attrs)).map(([name]) => name),
  );
}

const READ_RPCS = readOnlyFunctions(
  fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8') })),
);

function gateOf(tree: Tree, readRpcs: ReadonlySet<string>, notWrites: Record<string, string>) {
  return tree.graph.writeGate({
    gates: GATES.map((k) => absKey(tree, k)),
    readRpcs,
    notWrites: Object.keys(notWrites).map((k) => absKey(tree, k)),
  });
}

type EntryKind = 'action' | 'route' | 'service';
interface Entry {
  key: string;
  kind: EntryKind;
  verdict: WriteVerdict | null;
}

/** Every entry this guard reads, with its verdict. */
function entriesOf(
  tree: Tree,
  readRpcs: ReadonlySet<string> = READ_RPCS,
  notWrites: Record<string, string> = NOT_WRITES,
): Entry[] {
  const gate = gateOf(tree, readRpcs, notWrites);
  const out: Entry[] = [];
  for (const file of tree.graph.actionModules) {
    for (const name of tree.graph.runtimeExports(file)) {
      out.push({
        key: `${tree.rel(file)}#${name}`,
        kind: 'action',
        verdict: gate.exportVerdict(file, name),
      });
    }
  }
  for (const f of tree.files) {
    const rel = tree.rel(f.path);
    if (/^app\/api\/v1\/.+\/route\.tsx?$/.test(rel)) {
      for (const name of tree.graph.runtimeExports(f.path)) {
        if (!ROUTE_WRITE_METHODS.includes(name)) continue;
        out.push({
          key: `${rel}#${name}`,
          kind: 'route',
          verdict: gate.exportVerdict(f.path, name),
        });
      }
    }
    if (rel.startsWith('server/services/') && !tree.graph.actionModules.includes(f.path)) {
      for (const m of gate.publicMethods(f.path)) {
        out.push({
          key: `${rel}#${m.className}.${m.method}`,
          kind: 'service',
          verdict: gate.methodVerdict(f.path, m.className, m.method),
        });
      }
      for (const m of gate.objectMethods(f.path)) {
        out.push({
          key: `${rel}#${m.objectName}.${m.method}`,
          kind: 'service',
          verdict: gate.methodVerdict(f.path, m.objectName, m.method),
        });
      }
      // A class's methods and an object's functions are read above; another
      // value (a constant, a schema) runs nothing. A function that cannot be
      // read is reported (rule 1).
      for (const name of tree.graph.runtimeExports(f.path)) {
        const kind = gate.exportKind(f.path, name);
        if (kind !== 'fn' && kind !== 'alias') continue;
        out.push({
          key: `${rel}#${name}`,
          kind: 'service',
          verdict:
            kind === 'fn' ? gate.exportVerdict(f.path, name) : gate.aliasVerdict(f.path, name),
        });
      }
    }
  }
  return out;
}

const UNREADABLE = 'exported, but not as one function this guard can read';

function describeOpen(e: Entry): string {
  const v = e.verdict!;
  const write = v.openWrite!;
  const last =
    v.writeChain.length > 1 ? `, which writes at ${v.writeChain[v.writeChain.length - 1]}` : '';
  const conditional = v.conditionalGates.length
    ? `; a gate inside a condition: ${v.conditionalGates.map((g) => `${g.line} \`${g.text}\``).join(', ')}`
    : '';
  return `${e.key}:${write.line}: \`${write.text}\` writes before any authenticator gate${last}${conditional}`;
}

/** Rule 1: entries that write before any gate and are not listed, and action or route exports that cannot be read. */
function openEntries(entries: Entry[], reviewed: Record<string, Reviewed>): string[] {
  return entries
    .flatMap((e) => {
      if (!e.verdict) return [`${e.key}: ${UNREADABLE}`];
      if (!e.verdict.openWrite || reviewed[e.key]) return [];
      return [describeOpen(e)];
    })
    .sort();
}

/** Rule 1: entries that call a collaborator this reading cannot follow, and are not read by a person. */
function unfollowedEntries(entries: Entry[], resolved: Record<string, string>): string[] {
  return entries
    .flatMap((e) =>
      e.verdict?.unresolved.length && !resolved[e.key]
        ? [
            `${e.key}: calls a collaborator this guard cannot follow: ${e.verdict.unresolved.join('; ')}`,
          ]
        : [],
    )
    .sort();
}

/** Rule 2: entries resolved by reading that are gone, follow now, or give no reason. */
function staleResolved(entries: Entry[], resolved: Record<string, string>): string[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  return Object.entries(resolved)
    .flatMap(([key, reason]) => {
      const found = byKey.get(key);
      if (!found?.verdict) return [`${key}: no such entry`];
      const out: string[] = [];
      if (!found.verdict.unresolved.length)
        out.push(`${key}: every call is followed now, so it leaves the list`);
      if (reason.length <= 40) out.push(`${key}: no reason given`);
      return out;
    })
    .sort();
}

/** Rule 2: listed entries that are no longer true. */
function staleEntries(tree: Tree, entries: Entry[], reviewed: Record<string, Reviewed>): string[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const platform = tree.graph.reach(PLATFORM_GATES.map((k) => absKey(tree, k)));
  const portal = tree.graph.reach([absKey(tree, PORTAL_GATE)]);
  const member = tree.graph.reach(MEMBER_CONTEXTS.map((k) => absKey(tree, k)));
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(reviewed)) {
    const found = byKey.get(key);
    if (!found || !found.verdict) {
      problems.push(`${key}: no such entry`);
      continue;
    }
    const v = found.verdict;
    if (!v.writes) problems.push(`${key}: writes nothing, so it leaves the list`);
    else if (!v.openWrite)
      problems.push(`${key}: gives the answer before every write, so it leaves the list`);
    else {
      const pinned = new Set(entry.writes);
      for (const w of v.writeSet) {
        if (!pinned.has(w)) problems.push(`${key}: writes ${w}, which its entry does not pin`);
      }
      for (const w of entry.writes) {
        if (!v.writeSet.includes(w)) problems.push(`${key}: pins ${w}, which it does not write`);
      }
    }
    if (entry.reason.length <= 40) problems.push(`${key}: no reason given`);
    const [rel, name] = [key.slice(0, key.indexOf('#')), key.slice(key.indexOf('#') + 1)];
    const abs = tree.abs(rel);
    const isFunction = !name.includes('.');
    if (entry.kind === 'platform') {
      const ok =
        rel.startsWith('server/services/platform/') || rel === 'server/services/support-tickets.ts'
          ? found.kind === 'service'
          : isFunction && platform.exportReaches(abs, name) === true;
      if (!ok) problems.push(`${key}: listed as 'platform' but reaches no platform-admin gate`);
    }
    if (entry.kind === 'portal') {
      const ok =
        (rel === 'server/services/portal.ts' || rel === 'server/services/returns.ts') &&
        found.kind === 'service'
          ? true
          : isFunction && portal.exportReaches(abs, name) === true;
      if (!ok)
        problems.push(`${key}: listed as 'portal' but does not reach resolvePortalContext()`);
    }
    if (entry.kind === 'public' && (!isFunction || member.exportReaches(abs, name) !== false)) {
      problems.push(`${key}: listed as 'public' but builds a member context`);
    }
    if (entry.kind === 'link-or-member' && v.conditionalGates.length === 0) {
      problems.push(`${key}: listed as 'link-or-member' but gives no answer on any branch`);
    }
    if ((entry.kind === 'system' || entry.kind === 'internal') && found.kind !== 'service') {
      problems.push(`${key}: '${entry.kind}' is for service functions and methods only`);
    }
  }
  return problems.sort();
}

/**
 * Rule 2 and each mutation row read the whole tree (the first works out every
 * write set): a busy runner can take longer than the suite's default.
 */
const GUARD_TIMEOUT_MS = 60_000;

/** Set to print the current `writes` of every listed entry (see WHEN THIS FAILS). */
const PRINT_PINS_ENV = 'AUTHENTICATOR_GUARD_PRINT_PINS';

/**
 * The current write set of every listed entry, as `'<key>': [...]` lines in
 * REVIEWED's order, to copy into each entry's `writes`. Printing changes no
 * result: rule 2 still compares the pins as written.
 */
function freshPins(entries: Entry[], reviewed: Record<string, Reviewed>): string {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const lines = Object.keys(reviewed).map((key) => {
    const v = byKey.get(key)?.verdict;
    const writes = v ? v.writeSet.map((w) => `'${w}'`).join(', ') : '/* no such entry */';
    return `  '${key}': [${writes}],`;
  });
  return [`Current writes of the ${lines.length} listed entries:`, ...lines].join('\n');
}

/** One mutation: the source with `remove` taken out after `anchor`, close to it. */
function mutated(files: ReachFile[], srcRoot: string, m: Mutation): ReachFile[] {
  const target = path.join(srcRoot, m.file);
  let changed = 0;
  const out = files.map((f) => {
    if (f.path !== target) return f;
    const at = f.text.indexOf(m.anchor);
    const idx = at < 0 ? -1 : f.text.indexOf(m.remove, at);
    if (at < 0 || idx < 0 || idx - at > 4000) return f;
    changed += 1;
    return { path: f.path, text: f.text.slice(0, idx) + f.text.slice(idx + m.remove.length) };
  });
  if (changed !== 1)
    throw new Error(`${m.file}: \`${m.remove}\` not found right after \`${m.anchor}\``);
  return out;
}

/* ───────────────────────────── the real tree ───────────────────────────── */

const REAL_FILES = shippedSourceFiles(WEB_SRC, fs);
const REAL = treeOf(REAL_FILES, WEB_SRC);
const REAL_ENTRIES = entriesOf(REAL);

describe('every change to organization data gives the authenticator answer first', () => {
  it('reads a real tree', () => {
    const count = (kind: EntryKind) => REAL_ENTRIES.filter((e) => e.kind === kind).length;
    // On 2026-11-15: 360 actions, 120 write handlers under app/api/v1, and
    // 906 service methods and functions.
    expect(count('action')).toBeGreaterThan(330);
    expect(count('route')).toBeGreaterThan(100);
    expect(count('service')).toBeGreaterThan(800);
    const writers = REAL_ENTRIES.filter((e) => e.verdict?.writes);
    expect(writers.length).toBeGreaterThan(600);
    // Known shapes, read the way a person would: a gate in the service the
    // action calls, a route through a service instance, a written-out gate.
    for (const key of [
      'server/actions/inventory.ts#createItemAction',
      'app/api/v1/orders/[id]/lines/route.ts#POST',
      'server/actions/customers.ts#createCustomerAction',
      'server/services/order-requests.ts#OrderRequestsService.approve',
      // Injected collaborators with a default: `deps.grouping ?? new ItemGroupingService(ctx)`.
      'server/actions/item-grouping.ts#ungroupSelectedAction',
      'app/api/v1/items/ungroup-selected/route.ts#POST',
      // A signed upload URL is a storage write.
      'server/services/item-images.ts#ItemImagesService.createUploadUrl',
    ]) {
      const e = REAL_ENTRIES.find((x) => x.key === key);
      expect(e?.verdict?.writes, key).toBe(true);
      expect(e?.verdict?.openWrite, key).toBeNull();
    }
    // An object of functions: `export const PermissionExceptionsService = { set, listForMembers }`.
    const objectCall = REAL_ENTRIES.find(
      (x) => x.key === 'server/actions/platform/permission-exceptions.ts#setOrderItemsAccessAction',
    );
    expect(objectCall?.verdict?.writeSet).toContain('rpc:platform_set_permission_exception');
  });

  it('1. every entry that writes passes a gate before its first write, or is listed with a reason', () => {
    expect(openEntries(REAL_ENTRIES, REVIEWED)).toEqual([]);
  });

  it(
    '1. every entry that calls a collaborator this guard cannot follow is read by a person',
    () => {
      expect(unfollowedEntries(REAL_ENTRIES, RESOLVED_BY_READING)).toEqual([]);
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    '2. every listed entry is current, and writes only what it pins',
    () => {
      if (process.env[PRINT_PINS_ENV])
        process.stdout.write(`${freshPins(REAL_ENTRIES, REVIEWED)}\n`);
      expect(staleEntries(REAL, REAL_ENTRIES, REVIEWED)).toEqual([]);
      expect(staleResolved(REAL_ENTRIES, RESOLVED_BY_READING)).toEqual([]);
    },
    GUARD_TIMEOUT_MS,
  );

  it('3. the gates are where this guard thinks they are, and the context builders are none', () => {
    const plain = REAL.graph.writeGate({ gates: [], readRpcs: READ_RPCS });
    const context = REAL.abs(CONTEXT);
    expect(plain.exportVerdict(context, 'assertPermission')?.isGate).toBe(true);
    expect(plain.exportVerdict(context, 'assertAnyPermission')?.isGate).toBe(true);
    expect(plain.exportVerdict(context, 'withContext')?.isGate).toBe(false);
    expect(plain.exportVerdict(REAL.abs('lib/auth/api-context.ts'), 'withApiContext')?.isGate).toBe(
      false,
    );
    // The answer is mfaGateError's: assertPermission names it.
    const source = fs.readFileSync(context, 'utf8');
    const body = source.slice(source.indexOf('export function assertPermission('));
    expect(body.slice(0, body.indexOf('\n}'))).toContain(
      'if (ctx.mfaRequired && !ctx.mfaSatisfied) {\n    throw mfaGateError(ctx);',
    );
    for (const key of [...GATES, ...Object.keys(NOT_WRITES)]) {
      const [rel, name] = key.split('#') as [string, string];
      expect(fs.readFileSync(REAL.abs(rel), 'utf8'), key).toMatch(
        new RegExp(`function ${name}\\b`),
      );
    }
  });

  it('4. an RPC counts as a read only when its latest definition is STABLE or IMMUTABLE', () => {
    expect(READ_RPCS.size).toBeGreaterThan(40);
    expect(READ_RPCS.has('get_request_context')).toBe(true);
    for (const writer of [
      'transfer_org_ownership',
      'add_order_request_lines',
      'assign_picking',
      'increment_rate_limit',
    ]) {
      expect(READ_RPCS.has(writer), writer).toBe(false);
    }
  });

  describe('5. each gate, taken out of the real source, is reported', () => {
    it.each(MUTATIONS.map((m) => [`${m.file} after \`${m.anchor}\``, m] as const))(
      '%s',
      (_label, m) => {
        const tree = treeOf(mutated(REAL_FILES, WEB_SRC, m), WEB_SRC);
        const open = openEntries(entriesOf(tree), REVIEWED);
        for (const key of m.expect) {
          expect(
            open.find((line) => line.startsWith(`${key}:`)),
            key,
          ).toBeDefined();
        }
        if (m.conditional) {
          const line = open.find((l) => l.startsWith(`${m.expect[0]}:`))!;
          expect(line).toContain('a gate inside a condition');
          expect(line).toContain(m.conditional);
        }
      },
      GUARD_TIMEOUT_MS,
    );
  });
});

/* ───────────────────── self-test: each shape is read ───────────────────── */

describe('self-test: planted shapes are read as written', () => {
  const ROOT = '/planted';
  const CONTEXT_SRC = `
    export class ServiceError extends Error {}
    export function mfaGateError(ctx: unknown) { return new ServiceError('mfa'); }
    export function assertPermission(ctx: { mfaRequired: boolean; mfaSatisfied: boolean }, p: string) {
      if (ctx.mfaRequired && !ctx.mfaSatisfied) {
        throw mfaGateError(ctx);
      }
    }
    export function assertAnyPermission(ctx: unknown, p: string[]) {}
    export async function assertCurrentAal2(ctx: unknown) {}
    export async function withContext() { return { mfaRequired: true, mfaSatisfied: false }; }`;
  const base: Record<string, string> = {
    'server/services/context.ts': CONTEXT_SRC,
    'lib/rate-limit.ts': `export async function checkRateLimit(admin: any) { return admin.rpc('increment_rate_limit'); }`,
    'lib/books/lookup.ts': `async function writeBookCache(admin: any) { await admin.from('c').upsert({}); }
      export async function lookup(admin: any) { await writeBookCache(admin); }`,
    'lib/auth/platform-admin.ts': `
      export async function checkPlatformAdmin() { return { ok: true }; }
      export async function currentUserIsPlatformAdmin() { return true; }`,
    'lib/auth/session.ts': `export async function requireOrgContext() { return {}; }`,
    'lib/auth/api-context.ts': `export async function withApiContext(req: unknown) { return {}; }`,
    'server/services/portal.ts': `export async function resolvePortalContext() { return null; }`,
  };
  const tree = (files: Record<string, string>) =>
    treeOf(
      Object.entries({ ...base, ...files }).map(([k, text]) => ({ path: `${ROOT}/${k}`, text })),
      ROOT,
    );
  const READS = new Set(['read_things']);
  const open = (t: Tree, reviewed: Record<string, Reviewed> = {}) =>
    openEntries(entriesOf(t, READS, NOT_WRITES), reviewed).map((l) =>
      l.replace(/, which writes at .*?(;|$)/, '$1'),
    );
  const reason = 'x'.repeat(41);

  it('1. a write behind a gate passes; a write before one, beside one or without one is reported', () => {
    const t = tree({
      'server/services/things.ts': `
        import { assertPermission, mfaGateError, withContext, type ServiceContext } from './context';
        export class ThingsService {
          constructor(private ctx: any) {}
          static async forCurrentUser() { return new ThingsService(await withContext()); }
          private gate() { assertPermission(this.ctx, 'x'); }
          private policyGate() {
            if (this.ctx.mfaRequired && !this.ctx.mfaSatisfied) throw mfaGateError(this.ctx);
          }
          async gatedDirect() { assertPermission(this.ctx, 'x'); await this.ctx.supabase.from('t').insert({}); }
          async gatedByPolicyTest() { this.policyGate(); await this.ctx.supabase.from('t').delete(); }
          async gatedThroughThis() { this.gate(); await this.ctx.supabase.from('t').update({}); }
          async writesFirst() { await this.ctx.supabase.from('t').upsert({}); assertPermission(this.ctx, 'x'); }
          async ungated() { await this.ctx.supabase.rpc('write_things'); }
          async readsOnly() { await this.ctx.supabase.rpc('read_things'); return this.ctx.supabase.from('t').select('*'); }
          async storage() { await this.ctx.supabase.storage.from('b').remove(['p']); }
          async inACallback(ids: string[]) {
            await Promise.all(ids.map((id) => this.ctx.supabase.from('t').delete().eq('id', id)));
          }
          async throughAHelper() { await writeRow(this.ctx); }
          async bookkeepingOnly(admin: any) { await checkRateLimit(admin); }
        }
        async function writeRow(ctx: any) { const q = ctx.supabase.from('t'); await q.insert({}); }
        import { checkRateLimit } from '@/lib/rate-limit';`,
      'server/actions/a.ts': `'use server';
        import { ThingsService } from '@/server/services/things';
        import { withContext } from '@/server/services/context';
        export async function throughStatic() { const svc = await ThingsService.forCurrentUser(); await svc.gatedDirect(); }
        export async function throughNew() { await new ThingsService(await withContext()).ungated(); }
        export async function throughAnnotated(svc: ThingsService) { await svc.writesFirst(); }
        async function pair(): Promise<{ svc: ThingsService | null; error: string | null }> {
          return { svc: await ThingsService.forCurrentUser(), error: null };
        }
        export async function throughDestructured() { const { svc } = await pair(); await svc!.storage(); }`,
    });
    expect(open(t)).toEqual([
      'server/actions/a.ts#throughAnnotated:6: `svc.writesFirst()` writes before any authenticator gate',
      'server/actions/a.ts#throughDestructured:10: `svc!.storage()` writes before any authenticator gate',
      'server/actions/a.ts#throughNew:5: `new ThingsService(await withContext()).ungated()` writes before any authenticator gate',
      "server/services/things.ts#ThingsService.inACallback:18: `(id) => this.ctx.supabase.from('t').delete().eq('id', id)` writes before any authenticator gate",
      "server/services/things.ts#ThingsService.storage:16: `this.ctx.supabase.storage.from('b').remove(['p'])` writes before any authenticator gate",
      // A local through a helper: `const q = ctx.supabase.from('t'); q.insert()`.
      'server/services/things.ts#ThingsService.throughAHelper:20: `writeRow(this.ctx)` writes before any authenticator gate',
      "server/services/things.ts#ThingsService.ungated:14: `this.ctx.supabase.rpc('write_things')` writes before any authenticator gate",
      "server/services/things.ts#ThingsService.writesFirst:13: `this.ctx.supabase.from('t').upsert({})` writes before any authenticator gate",
    ]);
  });

  it('1. a gate inside a condition, a loop, a swallowing catch, or not awaited is named, never counted', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        import { assertPermission, assertCurrentAal2, mfaGateError, withContext } from '@/server/services/context';
        export async function inAnIf(own: boolean) {
          const ctx: any = await withContext();
          if (!own) assertPermission(ctx, 'x');
          await ctx.supabase.from('t').insert({});
        }
        export async function inALoop(ids: string[]) {
          const ctx: any = await withContext();
          for (const id of ids) assertPermission(ctx, id);
          await ctx.supabase.from('t').insert({});
        }
        export async function swallowed() {
          const ctx: any = await withContext();
          try { assertPermission(ctx, 'x'); } catch { /* carry on */ }
          await ctx.supabase.from('t').insert({});
        }
        export async function notAwaited() {
          const ctx: any = await withContext();
          void assertCurrentAal2(ctx);
          await ctx.supabase.from('t').insert({});
        }
        export async function bothBranches(own: boolean) {
          const ctx: any = await withContext();
          if (own) assertPermission(ctx, 'a'); else assertPermission(ctx, 'b');
          await ctx.supabase.from('t').insert({});
        }
        export async function catchThatLeaves() {
          const ctx: any = await withContext();
          try { assertPermission(ctx, 'x'); } catch (e) { return { ok: false }; }
          await ctx.supabase.from('t').insert({});
        }
        export async function policyTestThatReturns() {
          const ctx: any = await withContext();
          if (ctx.mfaRequired && !ctx.mfaSatisfied) return { ok: false };
          await ctx.supabase.from('t').insert({});
        }
        export async function earlyReturnThenGate(skip: boolean) {
          const ctx: any = await withContext();
          if (skip) return null;
          assertPermission(ctx, 'x');
          await ctx.supabase.from('t').insert({});
        }`,
    });
    expect(open(t)).toEqual([
      "server/actions/a.ts#inALoop:11: `ctx.supabase.from('t').insert({})` writes before any authenticator gate; a gate inside a condition: 10 `assertPermission(ctx, id)`",
      "server/actions/a.ts#inAnIf:6: `ctx.supabase.from('t').insert({})` writes before any authenticator gate; a gate inside a condition: 5 `assertPermission(ctx, 'x')`",
      "server/actions/a.ts#notAwaited:21: `ctx.supabase.from('t').insert({})` writes before any authenticator gate; a gate inside a condition: 20 `assertCurrentAal2(ctx)`",
      "server/actions/a.ts#swallowed:16: `ctx.supabase.from('t').insert({})` writes before any authenticator gate; a gate inside a condition: 15 `assertPermission(ctx, 'x')`",
    ]);
  });

  it('1. a helper that returns before its gate is no gate for its caller; one that throws is', () => {
    const t = tree({
      'server/services/helpers.ts': `
        import { mfaGateError } from './context';
        export function throwsAnswer(ctx: any) { if (ctx.mfaRequired && !ctx.mfaSatisfied) throw mfaGateError(ctx); }
        export function returnsAnswer(ctx: any) { if (ctx.mfaRequired && !ctx.mfaSatisfied) return 'refused'; return null; }`,
      'server/actions/a.ts': `'use server';
        import { throwsAnswer, returnsAnswer } from '@/server/services/helpers';
        export async function viaThrow(ctx: any) { throwsAnswer(ctx); await ctx.supabase.from('t').insert({}); }
        export async function viaReturn(ctx: any) { returnsAnswer(ctx); await ctx.supabase.from('t').insert({}); }`,
    });
    expect(open(t)).toEqual([
      "server/actions/a.ts#viaReturn:4: `ctx.supabase.from('t').insert({})` writes before any authenticator gate",
    ]);
  });

  it('1. an object of functions, an injected collaborator and a storage write are followed', () => {
    const t = tree({
      'server/services/objects.ts': `
        async function set(admin: any) { await admin.rpc('write_things'); }
        async function list(admin: any) { return admin.from('t').select('*'); }
        export const ThingsStore = { set, list, async drop(admin: any) { await admin.from('t').delete(); } };`,
      'server/services/writer.ts': `
        export class Writer {
          constructor(private ctx: any) {}
          async write() { await this.ctx.supabase.from('t').insert({}); }
        }
        export async function writeFn(ctx: any) { await ctx.supabase.from('t').update({}); }`,
      'server/services/holder.ts': `
        import { Writer, writeFn } from './writer';
        interface Deps { writer?: Writer; fn?: (ctx: any) => Promise<void> }
        export class Holder {
          private readonly writer: NonNullable<Deps['writer']>;
          private readonly fn: NonNullable<Deps['fn']>;
          constructor(private readonly ctx: any, deps: Deps = {}) {
            this.writer = deps.writer ?? new Writer(ctx);
            this.fn = deps.fn ?? writeFn;
          }
          async viaField() { await this.writer.write(); }
          async viaFunctionField() { await this.fn(this.ctx); }
        }`,
      'server/services/files.ts': `
        export class Files {
          constructor(private ctx: any) {}
          async signedUpload() { return this.ctx.supabase.storage.from('b').createSignedUploadUrl('p'); }
          async throughALocal() { const store = this.ctx.supabase.storage.from('b'); await store.upload('p', 'x'); }
        }`,
      'server/actions/a.ts': `'use server';
        import { ThingsStore } from '@/server/services/objects';
        import { Holder } from '@/server/services/holder';
        export async function viaObject(admin: any) { await ThingsStore.set(admin); }
        export async function viaHolder(ctx: any) { await new Holder(ctx).viaField(); }`,
    });
    expect(open(t)).toEqual([
      'server/actions/a.ts#viaHolder:5: `new Holder(ctx).viaField()` writes before any authenticator gate',
      'server/actions/a.ts#viaObject:4: `ThingsStore.set(admin)` writes before any authenticator gate',
      "server/services/files.ts#Files.signedUpload:4: `this.ctx.supabase.storage.from('b').createSignedUploadUrl('p')` writes before any authenticator gate",
      "server/services/files.ts#Files.throughALocal:5: `store.upload('p', 'x')` writes before any authenticator gate",
      'server/services/holder.ts#Holder.viaField:11: `this.writer.write()` writes before any authenticator gate',
      'server/services/holder.ts#Holder.viaFunctionField:12: `this.fn(this.ctx)` writes before any authenticator gate',
      "server/services/objects.ts#ThingsStore.drop:4: `admin.from('t').delete()` writes before any authenticator gate",
      "server/services/objects.ts#ThingsStore.set:2: `admin.rpc('write_things')` writes before any authenticator gate",
      "server/services/writer.ts#Writer.write:4: `this.ctx.supabase.from('t').insert({})` writes before any authenticator gate",
      "server/services/writer.ts#writeFn:6: `ctx.supabase.from('t').update({})` writes before any authenticator gate",
    ]);
  });

  it('1. a collaborator handed in with no default this guard can name is reported until a person reads it', () => {
    const t = tree({
      'server/services/holder.ts': `
        interface Store { save(): Promise<void> }
        export class Holder {
          private readonly store: Store;
          constructor(private readonly ctx: any, deps: { store: Store }) {
            this.store = deps.store;
          }
          async save() { await this.store.save(); }
        }`,
    });
    const entries = entriesOf(t, READS, NOT_WRITES);
    const line =
      'server/services/holder.ts#Holder.save: calls a collaborator this guard cannot follow: server/services/holder.ts:8 this.store.save()';
    expect(unfollowedEntries(entries, {})).toEqual([line]);
    expect(unfollowedEntries(entries, { 'server/services/holder.ts#Holder.save': reason })).toEqual(
      [],
    );
    expect(staleResolved(entries, { 'server/services/holder.ts#Holder.save': 'short' })).toEqual([
      'server/services/holder.ts#Holder.save: no reason given',
    ]);
    expect(staleResolved(entries, { 'server/services/holder.ts#Gone.save': reason })).toEqual([
      'server/services/holder.ts#Gone.save: no such entry',
    ]);
  });

  it('1. a service export that is another name for a function is read as that function', () => {
    const t = tree({
      'server/services/aliases.ts': `
        async function write(ctx: any) { await ctx.supabase.from('t').insert({}); }
        const handlers = { write };
        export const alias = handlers.write;
        export const direct = write;
        export const LIMIT = 5;
        export const COPY = 'Try again.';
        export const SAME_COPY = COPY;`,
    });
    expect(open(t)).toEqual([
      "server/services/aliases.ts#alias:2: `ctx.supabase.from('t').insert({})` writes before any authenticator gate",
      "server/services/aliases.ts#direct:2: `ctx.supabase.from('t').insert({})` writes before any authenticator gate",
    ]);
  });

  it('1. an action export that cannot be read is reported, listed or not', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        const handler = async () => 1;
        export const alias = handler;`,
    });
    const expected = [`server/actions/a.ts#alias: ${UNREADABLE}`];
    expect(open(t)).toEqual(expected);
    expect(
      open(t, { 'server/actions/a.ts#alias': { kind: 'personal', reason, writes: [] } }),
    ).toEqual(expected);
  });

  it('1. listing an entry covers that entry only', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        export async function one(ctx: any) { await ctx.supabase.from('t').insert({}); }
        export async function two(ctx: any) { await ctx.supabase.from('t').insert({}); }`,
    });
    expect(
      open(t, { 'server/actions/a.ts#one': { kind: 'personal', reason, writes: [] } }),
    ).toEqual([
      "server/actions/a.ts#two:3: `ctx.supabase.from('t').insert({})` writes before any authenticator gate",
    ]);
  });

  it('2. a listed entry that is gone, gated, writes nothing, gives no reason or is of the wrong kind is reported', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        import { assertPermission, withContext } from '@/server/services/context';
        import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
        export async function gated(ctx: any) { assertPermission(ctx, 'x'); await ctx.supabase.from('t').insert({}); }
        export async function readOnly(ctx: any) { return ctx.supabase.from('t').select('*'); }
        export async function open(ctx: any) { await ctx.supabase.from('t').insert({}); }
        export async function console(ctx: any) { await checkPlatformAdmin(); await ctx.supabase.from('t').insert({}); }
        export async function member() { const ctx: any = await withContext(); await ctx.supabase.from('t').insert({}); }`,
    });
    const entries = entriesOf(t, READS, NOT_WRITES);
    expect(
      staleEntries(t, entries, {
        'server/actions/a.ts#gated': { kind: 'personal', reason, writes: [] },
        'server/actions/a.ts#readOnly': { kind: 'personal', reason, writes: [] },
        'server/actions/a.ts#gone': { kind: 'personal', reason, writes: [] },
        'server/actions/a.ts#console': { kind: 'platform', reason, writes: ['t.insert'] },
        'server/actions/a.ts#open': { kind: 'platform', reason: 'short', writes: ['t.insert'] },
        'server/actions/a.ts#member': { kind: 'public', reason, writes: ['t.insert'] },
        'server/actions/a.ts#member2': { kind: 'internal', reason, writes: [] },
      }),
    ).toEqual([
      'server/actions/a.ts#gated: gives the answer before every write, so it leaves the list',
      'server/actions/a.ts#gone: no such entry',
      'server/actions/a.ts#member2: no such entry',
      "server/actions/a.ts#member: listed as 'public' but builds a member context",
      "server/actions/a.ts#open: listed as 'platform' but reaches no platform-admin gate",
      'server/actions/a.ts#open: no reason given',
      'server/actions/a.ts#readOnly: writes nothing, so it leaves the list',
    ]);
  });

  it('2. a listed entry that gains a write it does not pin, or pins one it does not make, is reported', () => {
    const t = tree({
      'server/actions/a.ts': `'use server';
        export async function open(ctx: any) {
          await ctx.supabase.from('prefs').upsert({});
          await ctx.supabase.from('orders').update({});
          await ctx.supabase.storage.from('docs').remove(['p']);
          await ctx.supabase.rpc('write_things');
        }`,
    });
    const entries = entriesOf(t, READS, NOT_WRITES);
    const key = 'server/actions/a.ts#open';
    const all = ['orders.update', 'prefs.upsert', 'rpc:write_things', 'storage:docs.remove'];
    expect(entries.find((e) => e.key === key)?.verdict?.writeSet).toEqual(all);
    expect(staleEntries(t, entries, { [key]: { kind: 'personal', reason, writes: all } })).toEqual(
      [],
    );
    expect(
      staleEntries(t, entries, {
        [key]: {
          kind: 'personal',
          reason,
          writes: ['prefs.upsert', 'rpc:write_things', 'storage:docs.remove', 'audit_logs.insert'],
        },
      }),
    ).toEqual([
      `${key}: pins audit_logs.insert, which it does not write`,
      `${key}: writes orders.update, which its entry does not pin`,
    ]);
    // The printed table gives the current writes to copy in.
    expect(freshPins(entries, { [key]: { kind: 'personal', reason, writes: [] } })).toContain(
      `  '${key}': ['orders.update', 'prefs.upsert', 'rpc:write_things', 'storage:docs.remove'],`,
    );
  });

  it('4. the volatility of the latest definition decides', () => {
    const read = readOnlyFunctions([
      {
        name: '0001.sql',
        text: 'create function public.a() returns int language sql stable as $$ select 1 $$;',
      },
      {
        name: '0002.sql',
        text: 'create or replace function public.a() returns int as $$ update t set x = 1 $$ language sql;',
      },
      {
        name: '0001b.sql',
        text: 'create function b() returns int as $fn$ select 1 $fn$ language sql immutable;',
      },
      {
        name: '0003.sql',
        text: 'create or replace function public.c() returns void language plpgsql as $$ begin end $$;',
      },
    ]);
    expect([...read].sort()).toEqual(['b']);
  });

  it('5. a mutation that does not find its gate fails loudly', () => {
    expect(() =>
      mutated([{ path: `${ROOT}/x.ts`, text: 'async function f() {}' }], ROOT, {
        file: 'x.ts',
        anchor: 'async function f(',
        remove: SERVICE_GATE,
        expect: [],
      }),
    ).toThrow(/not found/);
  });
});
