import 'server-only';

import {
  composeDisabledReason,
  disableReasonSchema,
  type AccountDisableCode,
  type DisableReasonInput,
} from '@stockpilot/core';

import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

import { recordPlatformAudit } from './audit';
import { revokeAllSessionsForUser } from './sessions';

/**
 * God-admin temporary account disable — the whole state machine.
 *
 * The action layer above (Task 5) runs checkPlatformAdmin({ requireStepUp:
 * true }) for the AAL2 + fresh-TOTP requirement. This service does NOT trust
 * that it ran: it re-resolves the actor's VERIFIED auth email and re-checks the
 * allowlist itself, so a future caller that forgets the gate cannot hand anyone
 * god-mode. What it cannot re-derive from a user id — the step-up freshness —
 * stays the wrapper's job.
 *
 * Two layers are written, in a fail-closed order:
 *
 *   1. user_profiles.disabled_at (Layer A) — the compare-and-set that BOTH
 *      request chokepoints read. Doing this first means the account is locked
 *      out of every page, Server Action and API route even if the rest fails.
 *   2. auth.users.banned_until (Layer B) — the only thing that blocks token
 *      REFRESH, new sign-ins, and the live getUser() every API request makes.
 *
 * then session revocation, then the audit row. A crash anywhere leaves the
 * account at least as locked as the completed prefix, and re-running the action
 * heals it: both Layer B steps run even on a CAS miss, which is what makes a
 * divergent flag/ban pair self-repairing.
 *
 * The live-device eviction broadcast is NOT emitted here.
 * revokeAllSessionsForUser owns it and fires it after the revoke actually
 * landed; a second broadcast from this file would be a duplicate eviction.
 */

/** ~100 years. GoTrue takes a duration string, not a timestamp. */
const DISABLE_BAN_DURATION = '876000h';
const CLEAR_BAN_DURATION = 'none';

export interface DisableUserAccountInput {
  targetUserId: string;
  reason: DisableReasonInput;
  /**
   * The platform admin performing the action. Only the ID is taken: the email
   * used for the allowlist check and the audit row is resolved from GoTrue
   * here, never accepted from the caller.
   */
  actorUserId: string;
}

export interface ReenableUserAccountInput {
  targetUserId: string;
  actorUserId: string;
}

/**
 * Which layer of a partially-applied change did not land. The operation still
 * succeeded — the authoritative flag is written — so these are what the surface
 * turns into "…but press it again" wording, one accurate sentence per token
 * instead of one vague "partial".
 */
export const ACCOUNT_STATUS_PARTIAL_REASONS = [
  /** Layer B: the GoTrue ban was not applied, so token refresh still works. */
  'ban_not_applied',
  /** Layer B: the GoTrue ban is still in place, so the user still cannot sign in. */
  'ban_not_lifted',
  /** Live sessions survive until their access tokens expire. */
  'sessions_not_revoked',
  /**
   * The action happened but no audit row landed. It is NOT rolled back — the
   * account must stay in the state the operator asked for — but the owner's
   * "every disable, revocation and re-enable is auditable" guarantee is broken
   * for this one, so it can never be reported as a clean success.
   */
  'not_audited',
] as const;
export type AccountStatusPartialReason = (typeof ACCOUNT_STATUS_PARTIAL_REASONS)[number];

export type DisableUserAccountResult =
  | {
      ok: true;
      /** True when the CAS found the account already disabled (a safe replay). */
      alreadyDisabled: boolean;
      banned: boolean;
      sessionsRevoked: number;
      /** True when Layer A landed but a later layer did not. */
      partial: boolean;
      /** Empty when `partial` is false. */
      partialReasons: AccountStatusPartialReason[];
    }
  | { ok: false; code: AccountDisableCode };

export type ReenableUserAccountResult =
  | {
      ok: true;
      alreadyActive: boolean;
      /** True when the GoTrue ban is STILL in place because lifting it failed. */
      banned: boolean;
      partial: boolean;
      /** Empty when `partial` is false. */
      partialReasons: AccountStatusPartialReason[];
    }
  | { ok: false; code: AccountDisableCode };

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Resolves a user's VERIFIED auth email. Never `user_profiles.email`: RLS lets
 * a user update their own profile row, so that column is attacker-controlled
 * and using it here would let someone dodge the protected-admin refusal — or
 * pass the actor check — by editing their own profile.
 *
 * `undefined` = no such auth user; `null` = the user exists with no email.
 */
async function verifiedEmailForUser(
  admin: AdminClient,
  userId: string,
): Promise<string | null | undefined> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return undefined;
  return data.user.email ?? null;
}

/**
 * Defence in depth: the actor must still be an allowlisted platform admin as
 * far as GoTrue is concerned, whatever the caller believes. Fail-closed — an
 * unknown actor, an emailless actor or a failed lookup all refuse.
 */
async function verifiedPlatformAdminEmail(
  admin: AdminClient,
  actorUserId: string,
): Promise<string | null> {
  const email = await verifiedEmailForUser(admin, actorUserId);
  if (typeof email !== 'string' || !isPlatformAdmin(email)) return null;
  return email;
}

export async function disableUserAccount(
  input: DisableUserAccountInput,
): Promise<DisableUserAccountResult> {
  const admin = createAdminClient();

  const actorEmail = await verifiedPlatformAdminEmail(admin, input.actorUserId);
  if (!actorEmail) return { ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' };

  const email = await verifiedEmailForUser(admin, input.targetUserId);
  if (email === undefined) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  // Refusing EVERY allowlisted email covers three requirements at once: no
  // self-disable, no disabling a peer god admin, and no way to lock out the
  // last god admin. The allowlist is deploy-time env and cannot shrink at
  // runtime, so no "is this the last one" counting is possible or needed.
  if (isPlatformAdmin(email)) return { ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' };

  // Re-parsed with the SHARED schema rather than trusted from the dialog: it is
  // what enforces "notes are mandatory when the category is Other" and the
  // 500-character cap on the server side too.
  const parsed = disableReasonSchema.safeParse(input.reason);
  if (!parsed.success) return { ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' };
  const reason = composeDisabledReason(parsed.data).trim();
  if (reason.length === 0) return { ok: false, code: 'ACCOUNT_DISABLE_REASON_REQUIRED' };

  // The linearization point. `.is('disabled_at', null)` makes this a
  // compare-and-set: two concurrent clicks produce exactly one winner, so
  // exactly one audit row. The returned rows are CHECKED — an unchecked
  // .update().eq() that matched nothing is the repo's classic fail-open bug.
  const { data: casRows, error: casError } = await admin
    .from('user_profiles')
    .update({
      disabled_at: new Date().toISOString(),
      disabled_reason: reason,
      disabled_by: input.actorUserId,
    })
    .eq('id', input.targetUserId)
    .is('disabled_at', null)
    .select('id');

  if (casError) {
    await reportError(new Error(casError.message), {
      tag: 'platform.account-disable.cas',
      extra: { targetUserId: input.targetUserId },
    });
    // A CONCURRENCY outcome, not an authorization one: the actor's allowlist
    // membership was verified above, so nothing that fails here means "you may
    // not do this". Serialization failures, deadlocks and a peer admin moving
    // the same row all land here, and the honest instruction for every one of
    // them is "reload and try again".
    return { ok: false, code: 'ACCOUNT_STATUS_CHANGED' };
  }

  const alreadyDisabled = ((casRows ?? []) as Array<{ id: string }>).length === 0;

  // Layer B runs even on a CAS miss so a flag-set/ban-missing divergence heals
  // by pressing Disable again. auth-js 2.105.1 takes a DURATION string here
  // (ns/us/ms/s/m/h), not a timestamp; 'none' is the documented lift.
  const { error: banError } = await admin.auth.admin.updateUserById(input.targetUserId, {
    ban_duration: DISABLE_BAN_DURATION,
  });
  if (banError) {
    await reportError(new Error(banError.message), {
      tag: 'platform.account-disable.ban',
      extra: { targetUserId: input.targetUserId },
    });
  }
  const banned = !banError;

  // Kills the live sessions and evicts the devices. The helper reports rather
  // than throws, and it emits the ONE eviction broadcast itself.
  const revoked = await revokeAllSessionsForUser(input.targetUserId);

  // The audit write is best-effort by design — the account is ALREADY disabled
  // and must stay that way — but its failure is carried out to the caller. A
  // CHECK violation (0308 not pushed yet) or a transient error would otherwise
  // leave a fully disabled user with no audit row and a clean-success return,
  // which is exactly the guarantee the owner's brief refuses to lose.
  //
  // ATTEMPTED ON A REPLAY TOO. This used to read `alreadyDisabled ? true : ...`,
  // and that shortcut is what turned a lost audit row into a permanent one: the
  // first press came back partial (say ban_not_applied + not_audited), the
  // operator was told to press Disable again, and the second press forced
  // audited=true, returned no partial reasons and reported a clean success with
  // the user_disabled row never written. Pressing Disable on an already-disabled
  // account re-asserts the same action, so recording it is correct — and it is
  // the only thing that makes the advertised retry able to close the gap.
  const audited = await recordPlatformAudit({
    actorUserId: input.actorUserId,
    actorEmail,
    action: 'user_disabled',
    targetUserId: input.targetUserId,
    detail: {
      reason,
      reason_category: parsed.data.category,
      sessions_revoked: revoked.sessionIds.length,
      sessions_revoke_ok: revoked.ok,
      banned,
      // Honest about which press this row describes. On a replay the CAS wrote
      // nothing, so `reason` is what THIS operator typed, not what is stored on
      // the profile, and the account was already disabled before the press.
      already_disabled: alreadyDisabled,
    },
  });

  // Layer A landed, so the account IS locked out; these tell the UI which
  // deeper layer needs the button pressed again.
  const partialReasons: AccountStatusPartialReason[] = [];
  if (!banned) partialReasons.push('ban_not_applied');
  if (!revoked.ok) partialReasons.push('sessions_not_revoked');
  if (!audited) partialReasons.push('not_audited');

  return {
    ok: true,
    alreadyDisabled,
    banned,
    sessionsRevoked: revoked.sessionIds.length,
    partial: partialReasons.length > 0,
    partialReasons,
  };
}

export async function reenableUserAccount(
  input: ReenableUserAccountInput,
): Promise<ReenableUserAccountResult> {
  const admin = createAdminClient();

  const actorEmail = await verifiedPlatformAdminEmail(admin, input.actorUserId);
  if (!actorEmail) return { ok: false, code: 'ACCOUNT_DISABLE_NOT_AUTHORIZED' };

  const email = await verifiedEmailForUser(admin, input.targetUserId);
  if (email === undefined) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

  const { data: casRows, error: casError } = await admin
    .from('user_profiles')
    .update({ disabled_at: null, disabled_reason: null, disabled_by: null })
    .eq('id', input.targetUserId)
    .not('disabled_at', 'is', null)
    .select('id');

  if (casError) {
    await reportError(new Error(casError.message), {
      tag: 'platform.account-reenable.cas',
      extra: { targetUserId: input.targetUserId },
    });
    // Same reasoning as the disable path: a lost write is a concurrent change,
    // never a permission problem.
    return { ok: false, code: 'ACCOUNT_STATUS_CHANGED' };
  }

  const alreadyActive = ((casRows ?? []) as Array<{ id: string }>).length === 0;

  // Executed even on a CAS miss: a cleared flag with a stray ban is exactly the
  // divergence Re-enable exists to heal, and a user in that state cannot sign
  // in at all until the ban is lifted.
  const { error: banError } = await admin.auth.admin.updateUserById(input.targetUserId, {
    ban_duration: CLEAR_BAN_DURATION,
  });
  if (banError) {
    await reportError(new Error(banError.message), {
      tag: 'platform.account-reenable.unban',
      extra: { targetUserId: input.targetUserId },
    });
  }

  // No revocation and no broadcast: re-enable only GRANTS access. The sessions
  // killed by the disable stay dead — the user signs in again, which mints a
  // fresh one.
  // Re-attempted on the already-active healing path for the same reason as the
  // disable above: the retry the operator is told to perform must actually be
  // able to write the row it is retrying for.
  const audited = await recordPlatformAudit({
    actorUserId: input.actorUserId,
    actorEmail,
    action: 'user_reenabled',
    targetUserId: input.targetUserId,
    detail: { ban_cleared: !banError, already_active: alreadyActive },
  });

  const partialReasons: AccountStatusPartialReason[] = [];
  if (banError) partialReasons.push('ban_not_lifted');
  if (!audited) partialReasons.push('not_audited');

  return {
    ok: true,
    alreadyActive,
    banned: !!banError,
    partial: partialReasons.length > 0,
    partialReasons,
  };
}
