import * as SecureStore from 'expo-secure-store';

/**
 * THE DEVICE'S OWN MEMORY OF WHO LAST SIGNED IN HERE.
 *
 * account-eviction.ts's shouldRunEviction() trusts only DisableEvidence
 * 'session' — a verdict about the live session THIS device holds — because
 * GoTrue answers `user_banned` to a failed password grant for ANY typed
 * password, before it ever checks the password. A verdict raised at the
 * sign-in screen therefore says nothing on its own about whose device it is:
 * a passer-by who merely knows one disabled colleague's email reaches it
 * exactly as easily as the account's own owner.
 *
 * The first fix for that (eb3c7e3c) refused to attribute 'session' evidence
 * to a sign-in rejection at all. That over-corrected: after a platform
 * disable, the device's OWN owner — relaunching a phone that was offline or
 * closed when the disable landed — converges on this exact same sign-in
 * screen too (see use-account-gate.ts's design note on WHICH PATHS CAN
 * ACTUALLY CONFIRM A DISABLE). Refusing every sign-in rejection left their own
 * outbox rows stuck 'pending' forever (invisible to the "Unsent work" list,
 * and drained under the NEXT person who signs in on that device) and the
 * cached org snapshot never cleared, because nothing else in the app wipes
 * either of those.
 *
 * This module is what lets the sign-in path earn 'session' evidence honestly.
 * Every device remembers, in durable storage, the identity of whoever last
 * held a session on it — refreshed at every cold-launch hydrate and every
 * sign-out, so it survives a relaunch and names the CURRENT owner even across
 * a shared warehouse phone changing hands. When a sign-in is rejected with
 * `user_banned`, auth-context compares the typed address against this record:
 * a match means the device is hearing about its own disable; anything else —
 * a stranger's typed guess, or a device that has never held a session for
 * this address — gets the screen only, never the eviction.
 *
 * The comparison can only ever be by EMAIL. A rejected `user_banned` sign-in
 * never returns a resolved user — GoTrue refuses before it checks the
 * password — so the typed address is the only value the sign-in side of the
 * comparison can ever hold. `userId` is still recorded whenever a live
 * session makes it available (sign-out, hydrate already have the full user
 * object in hand) because it is the more stable field and costs nothing to
 * keep, but it plays no part in matchesRememberedIdentity below.
 *
 * Storage is expo-secure-store — the SAME backend biometric.ts and
 * scanner-tip-flag.ts already use, and deliberately NOT AsyncStorage. This
 * record must survive both wipeForSignOut (db.ts — SQLite only) and the
 * eviction's clearAccountStorage step (account-eviction.ts's
 * ACCOUNT_SCOPED_STORAGE_PREFIXES — AsyncStorage `workspace.*` keys only).
 * Neither touches the Keychain/Keystore, so nothing here ever has to
 * re-record after either wipe.
 *
 * A SINGLE slot, not one per user (unlike biometric.ts's per-user opt-in
 * flag): the question this answers is "whose device is this right now", and
 * the previous holder's record is exactly what should be overwritten the
 * moment a new identity signs in or is hydrated.
 */

const STORAGE_KEY = 'sp_last_signed_in_identity_v1';

export interface RememberedIdentity {
  /** The account's stable id, when a live session made it available. */
  userId: string | null;
  /** Trimmed, lowercased — see normalizeIdentityEmail. */
  email: string | null;
}

/** Trim + lowercase, so a re-cased or padded retype still matches. */
export function normalizeIdentityEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Does a TYPED sign-in address belong to whoever this device last remembers?
 *
 * See the module doc above for why this is, and can only ever be, an email
 * comparison. Fails CLOSED (false) whenever there is nothing usable to
 * compare against — no remembered record at all, or one that only ever
 * captured a userId — matching shouldRunEviction's own fail-closed posture:
 * no attribution is always safer than a false one.
 */
export function matchesRememberedIdentity(
  typedEmail: string,
  remembered: RememberedIdentity | null,
): boolean {
  if (!remembered?.email) return false;
  return normalizeIdentityEmail(typedEmail) === remembered.email;
}

function serialize(identity: RememberedIdentity): string {
  return JSON.stringify(identity);
}

function parse(raw: string | null): RememberedIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof RememberedIdentity, unknown>>;
    const email = typeof parsed.email === 'string' ? parsed.email : null;
    const userId = typeof parsed.userId === 'string' ? parsed.userId : null;
    if (!email && !userId) return null;
    return { userId, email };
  } catch {
    return null;
  }
}

/**
 * Reads the remembered identity. Never rejects: an unreadable Keychain must
 * fail CLOSED for the eviction precondition (no attribution rather than a
 * false one), exactly like every other probe in this feature.
 */
export async function getRememberedIdentity(): Promise<RememberedIdentity | null> {
  try {
    return parse(await SecureStore.getItemAsync(STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Records the identity now signed in / just signed out on this device.
 *
 * Fire-and-forget safe: never rejects, so callers in auth-context.tsx's
 * hot sign-in / sign-out paths can await it without an extra try/catch. A
 * write failure here means only that a later disabled sign-in cannot be
 * attributed to this device — the eviction still fails CLOSED
 * (shouldRunEviction's default), never open, so nothing destructive follows
 * from losing this record.
 */
export async function rememberIdentity(identity: RememberedIdentity): Promise<void> {
  if (!identity.userId && !identity.email) return;
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, serialize(identity));
  } catch {
    // Swallow. See the doc comment above.
  }
}
