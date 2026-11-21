import 'server-only';

import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import { PASSKEY_BRIDGE_NAME_PREFIX } from '@/lib/auth/passkey-bridge-name';
import { passkeyRelyingParty } from '@/lib/auth/passkey-relying-party';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * THE LAST-METHOD RULE (stage 4, integrator decision B of 2026-11-21): one
 * rule for authenticator apps and passkeys. The member's LAST second-step
 * method cannot be removed while the policy of an organization the member
 * belongs to requires a second step of them (all_required; admins_required
 * for an owner or admin). Removing one of two methods is allowed.
 *
 * Methods counted: verified authenticator apps (TOTP; never a factor that
 * carries the reserved bridge name) and active passkeys of this site. With
 * no site configured no passkey can serve here, so none is counted.
 *
 * Strict on doubt: a factor list or a passkey list that cannot be read is an
 * unknown count, and an unknown count is treated as the last method; a
 * policy that cannot be read requires a second step (enforcedMfaPolicy's
 * strictest, and any failed read). It reads only what it needs: no passkey
 * read while an app remains, no policy read while a method remains.
 *
 * Callers: unenrollFactorAction (server/actions/mfa.ts) and removePasskey
 * (server/security/passkeys.ts). The same words for both.
 */

export const LAST_METHOD_WORDS =
  'Your organization requires a second step. Add another authenticator app or passkey before you remove this one.';

export type RemovingMethod =
  | { kind: 'app'; factorId: string }
  | { kind: 'passkey'; passkeyId: string };

type FactorLike = { id?: unknown; factor_type?: unknown; status?: unknown; friendly_name?: unknown };
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

/** The account's active passkeys of this site, by id, or null when they cannot be read. */
async function activePasskeyIds(admin: Admin, userId: string): Promise<string[] | null> {
  const rp = passkeyRelyingParty();
  if (!rp) return [];
  try {
    const { data, error } = await admin
      .from('member_passkeys')
      .select('id')
      .eq('user_id', userId)
      .eq('rp_id', rp.rpId)
      .is('removed_at', null)
      .limit(20);
    if (error || !Array.isArray(data)) return null;
    return (data as Array<{ id?: unknown }>).map((r) => String(r.id));
  } catch {
    return null;
  }
}

/**
 * Whether any organization of the member requires a second step for their
 * role. Memberships accepted and not an act-as seat (as 0413 and 0475 count
 * them). Strictest when anything cannot be read.
 */
export async function secondStepRequired(admin: Admin, userId: string): Promise<boolean> {
  try {
    const { data: memberships, error } = await admin
      .from('organization_members')
      .select('organization_id, role')
      .eq('user_id', userId)
      .not('accepted_at', 'is', null)
      .is('impersonation_expires_at', null);
    if (error || !Array.isArray(memberships)) return true;
    for (const m of memberships as Array<{ organization_id: string; role: string }>) {
      const { data: org, error: orgError } = await admin
        .from('organizations')
        .select('mfa_policy')
        .eq('id', m.organization_id)
        .maybeSingle();
      if (orgError) return true;
      const policy = enforcedMfaPolicy(org);
      if (policy === 'all_required') return true;
      if (policy === 'admins_required' && (m.role === 'owner' || m.role === 'admin')) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * True when removing `removing` must be refused: it is (or may be) the
 * account's last second-step method and a policy requires one.
 */
export async function lastMethodBlocks(input: {
  userId: string;
  removing: RemovingMethod;
  /** The account's factor list, or null when it could not be read. */
  factors: ReadonlyArray<FactorLike> | null;
  /** The account's active passkeys of this site, when the caller already read them. */
  passkeyIds?: ReadonlyArray<string>;
  /** The caller already read a policy that requires a second step (the active organization's). */
  requiredKnown?: boolean;
}): Promise<boolean> {
  const { userId, removing } = input;
  let admin: Admin | null = null;
  const adminClient = () => (admin ??= createAdminClient());

  const apps = input.factors === null ? null : input.factors.filter(isApp).map((f) => f.id);
  // Removing an app that is not a method (unverified, or not listed) leaves
  // every method in place.
  if (removing.kind === 'app' && apps !== null && !apps.includes(removing.factorId)) return false;
  const appsLeft =
    apps === null
      ? null
      : apps.filter((id) => !(removing.kind === 'app' && id === removing.factorId)).length;
  if (appsLeft !== null && appsLeft > 0) return false;

  const passkeys = input.passkeyIds ?? (await activePasskeyIds(adminClient(), userId));
  if (removing.kind === 'passkey' && passkeys !== null && !passkeys.includes(removing.passkeyId))
    return false;
  const passkeysLeft =
    passkeys === null
      ? null
      : passkeys.filter((id) => !(removing.kind === 'passkey' && id === removing.passkeyId)).length;
  if (passkeysLeft !== null && passkeysLeft > 0) return false;

  // No method left, or a count that could not be read.
  if (input.requiredKnown) return true;
  return secondStepRequired(adminClient(), userId);
}
