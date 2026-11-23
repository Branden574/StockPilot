import 'server-only';

import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import { FACTOR_CHECK_RETRY } from '@/lib/auth/passkey-bridge';
import { carriesBridgeName, PASSKEY_BRIDGE_NAME_PREFIX } from '@/lib/auth/passkey-bridge-name';
import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * THE LAST-METHOD RULE (stage 4, integrator decision B of 2026-11-21, with
 * the two corrections of the same day): one rule for authenticator apps and
 * passkeys. The member's LAST second-step method cannot be removed while the
 * policy of an organization the member belongs to requires a second step of
 * them (all_required; admins_required for an owner or admin). Removing one
 * of two methods is allowed.
 *
 * Methods counted:
 *   - verified authenticator apps: TOTP factors, verified, never a factor
 *     that carries the reserved bridge name;
 *   - passkeys that can ACTUALLY serve as the second step now (correction
 *     1). The caller judges them, by the second-step page's own rule
 *     (server/security/passkeys.ts servingPasskeyIds, or the removal's own
 *     account picture): an active row of this site AND a recorded bridge
 *     whose reserved-name TOTP factor exists and is verified, in a state
 *     where the bridge answers, with a secret the keys open, the USE level
 *     open. A passkey row alone is no method; removing a passkey that cannot
 *     serve removes no method.
 *
 * Unknown is never fine (correction 2): when the app count is unknown (the
 * factor list could not be read, or was another account's) the passkeys are
 * not asked at all (their bridge cannot be judged without the list), and the
 * count is unknown; a passkey judgement that could not be made is unknown
 * too. An unknown count may be the last method: under a policy that requires
 * a second step the answer is "try again in a moment" (the bridge check's
 * own sentence, FACTOR_CHECK_RETRY), never "allowed". A policy that cannot
 * be read is the same: try again, unless another organization of the member
 * is read as requiring (then the rule's own words). Only a policy read as
 * not requiring a second step lets an unknown count go.
 *
 * It reads only what it needs: no passkey judgement while an app remains, no
 * policy read while a method remains or the caller already read a requiring
 * policy.
 *
 * Callers: removePasskey (server/security/passkeys.ts), and
 * unenrollFactorAction (server/actions/mfa.ts) through appRemovalVerdict
 * below, for an account that holds a passkey. The same words for both.
 *
 * THE NO-CHANGE RULE (integrator, 2026-11-21): stage 4 changes nothing for
 * today's members while passkeys are dark. Removing an authenticator app
 * from an account that holds no passkey is decided exactly as before this
 * work (appRemovalVerdict 'policy': refused while the ACTIVE organization's
 * policy requires a second step of the member, with the base's words, which
 * name no passkey), and no passkey table is read for it. The unified rule
 * above is for an account that holds an active passkey of this site
 * (passkeyHolder).
 */

export const LAST_METHOD_WORDS =
  'Your organization requires a second step. Add another authenticator app or passkey before you remove this one.';

/** Correction 2: the answer when the state could not be read (the bridge check's own sentence). */
export const LAST_METHOD_RETRY_WORDS = FACTOR_CHECK_RETRY;

export type RemovingMethod =
  { kind: 'app'; factorId: string } | { kind: 'passkey'; passkeyId: string };

/**
 * 'allowed'; 'last_method' (refuse with LAST_METHOD_WORDS); 'unreadable'
 * (refuse with LAST_METHOD_RETRY_WORDS: what decides could not be read).
 */
export type LastMethodVerdict = 'allowed' | 'last_method' | 'unreadable';

type FactorLike = {
  id?: unknown;
  factor_type?: unknown;
  status?: unknown;
  friendly_name?: unknown;
};
type Admin = ReturnType<typeof createAdminClient>;

/** A verified TOTP factor, with an id, without the reserved bridge name. */
function isApp(f: FactorLike): f is FactorLike & { id: string } {
  return (
    typeof f.id === 'string' &&
    f.factor_type === 'totp' &&
    f.status === 'verified' &&
    !(typeof f.friendly_name === 'string' && f.friendly_name.startsWith(PASSKEY_BRIDGE_NAME_PREFIX))
  );
}

/**
 * Whether any organization of the member requires a second step for their
 * role. Memberships accepted and not an act-as seat (as 0413 and 0475 count
 * them). 'required' as soon as one does; 'unreadable' when none does but the
 * memberships, a policy or an organization row could not be read; a policy
 * word this build does not know is the strictest (enforcedMfaPolicy).
 */
export async function secondStepPolicy(
  admin: Admin,
  userId: string,
): Promise<'required' | 'not_required' | 'unreadable'> {
  try {
    const { data: memberships, error } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null);
    if (error || !Array.isArray(memberships)) return 'unreadable';
    let unread = false;
    for (const m of memberships as Array<{ organization_id: string; role: string }>) {
      const { data: org, error: orgError } = await admin
        .from('organizations')
        .select('mfa_policy')
        .eq('id', m.organization_id)
        .maybeSingle();
      if (orgError || org === null) {
        unread = true;
        continue;
      }
      const policy = enforcedMfaPolicy(org);
      if (policy === 'all_required') return 'required';
      if (policy === 'admins_required' && (m.role === 'owner' || m.role === 'admin'))
        return 'required';
    }
    return unread ? 'unreadable' : 'not_required';
  } catch {
    return 'unreadable';
  }
}

/** The caller's judgement, or null (unknown) when it throws or answers nothing usable. */
async function servingOf(
  ask: () => Promise<ReadonlyArray<string> | null>,
): Promise<ReadonlyArray<string> | null> {
  try {
    const ids = await ask();
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Whether the account holds an active passkey of this site: 'holder', 'none'
 * or 'unreadable'. ACTIVE, of THIS site: the passkeys the member sees on the
 * Security page and can use here; a member who removed theirs, or whose only
 * passkey belongs to another site, is back to the base rule and its words.
 *
 * Names first (as lib/auth/passkey-bridge reads the bridge record): a
 * passkey that can serve, or be finished, leaves a factor with the reserved
 * bridge name at Auth, so only a factor list that carries that name leads to
 * the one row read that tells. A list that cannot be read (or is another
 * account's), or one without the name, is 'none' with nothing read: every
 * account without a passkey (all of today's) is decided as before, with no
 * new read. An account whose passkey row has lost its bridge factor (a setup
 * not finished, no passkey that can serve) is 'none' too. No site: 'none'
 * (no passkey is held here). A table that does not exist yet holds nothing.
 */
export async function passkeyHolder(
  userId: string,
  factors: ReadonlyArray<{ friendly_name?: unknown }> | null,
): Promise<'holder' | 'none' | 'unreadable'> {
  if (factors === null || !factors.some(carriesBridgeName)) return 'none';
  const rp = passkeyRelyingParty();
  if (!rp) return 'none';
  try {
    const { data, error } = await createAdminClient()
      .from('member_passkeys')
      .select('id')
      .eq('user_id', userId)
      .eq('rp_id', rp.rpId)
      .is('removed_at', null)
      .limit(1);
    if (error) {
      const code = (error as { code?: unknown }).code;
      return code === 'PGRST205' || code === '42P01' ? 'none' : 'unreadable';
    }
    if (!Array.isArray(data)) return 'unreadable';
    return data.length > 0 ? 'holder' : 'none';
  } catch {
    return 'unreadable';
  }
}

/**
 * Removing an authenticator app (unenrollFactorAction): 'policy' (the base
 * rule: refuse with the base's words), 'last_method', 'unreadable' (try
 * again) or 'allowed'.
 *   - No passkey held: the base rule exactly, on the active organization's
 *     policy the caller read; nothing else is asked.
 *   - A holder: the unified rule (lastMethodVerdict, both corrections).
 *   - Whether the account holds one could not be read: try again under the
 *     active organization's requiring policy (either rule could hold);
 *     otherwise the unified rule with the passkeys unknown.
 */
export async function appRemovalVerdict(input: {
  userId: string;
  factorId: string;
  /** The account's factor list, or null when it could not be read (or was another account's). */
  factors: ReadonlyArray<FactorLike> | null;
  /** The active organization's policy requires a second step of the member. */
  activeRequired: boolean;
  servingPasskeys: () => Promise<ReadonlyArray<string> | null>;
}): Promise<LastMethodVerdict | 'policy'> {
  const holder = await passkeyHolder(input.userId, input.factors);
  if (holder === 'none') return input.activeRequired ? 'policy' : 'allowed';
  if (holder === 'unreadable' && input.activeRequired) return 'unreadable';
  return lastMethodVerdict({
    userId: input.userId,
    removing: { kind: 'app', factorId: input.factorId },
    factors: input.factors,
    servingPasskeys: holder === 'holder' ? input.servingPasskeys : async () => null,
    requiredKnown: input.activeRequired,
  });
}

/** The rule's verdict on removing `removing`. */
export async function lastMethodVerdict(input: {
  userId: string;
  removing: RemovingMethod;
  /** The account's factor list, or null when it could not be read (or was another account's). */
  factors: ReadonlyArray<FactorLike> | null;
  /**
   * The ids of the account's passkeys that can serve as its second step now,
   * or null when that cannot be told. Asked only when no app would remain,
   * and never with an unknown factor list.
   */
  servingPasskeys: () => Promise<ReadonlyArray<string> | null>;
  /** The caller already read a policy that requires a second step (the active organization's). */
  requiredKnown?: boolean;
}): Promise<LastMethodVerdict> {
  const { userId, removing } = input;

  // How many methods would remain: a number, or null (unknown).
  let left: number | null;
  if (input.factors === null) {
    // Correction 2: an unknown app count; the passkeys are not asked.
    left = null;
  } else {
    const apps = input.factors.filter(isApp).map((f) => f.id);
    // Removing an app that is no method (unverified, not listed, the
    // reserved name) leaves every method in place.
    if (removing.kind === 'app' && !apps.includes(removing.factorId)) return 'allowed';
    const appsLeft = apps.filter((id) => !(removing.kind === 'app' && id === removing.factorId));
    if (appsLeft.length > 0) return 'allowed';
    const serving = await servingOf(input.servingPasskeys);
    if (serving === null) {
      left = null;
    } else {
      // Correction 1: a passkey that cannot serve is no method.
      if (removing.kind === 'passkey' && !serving.includes(removing.passkeyId)) return 'allowed';
      left = serving.filter(
        (id) => !(removing.kind === 'passkey' && id === removing.passkeyId),
      ).length;
      if (left > 0) return 'allowed';
    }
  }

  // No method would remain, or the count is unknown: the policy decides.
  const policy = input.requiredKnown
    ? 'required'
    : await secondStepPolicy(createAdminClient(), userId);
  if (policy === 'not_required') return 'allowed';
  if (policy === 'unreadable' || left === null) return 'unreadable';
  return 'last_method';
}
