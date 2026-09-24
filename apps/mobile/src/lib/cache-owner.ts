/**
 * WHOSE CACHE IS THIS? (a #242 follow-up)
 *
 * The phone's SQLite cache is pulled for one account: its warehouse scope, its
 * permissions, and a delta cursor (`last_synced_at`) on that account's
 * timeline. "Use password instead", "Use a different account", a revoked
 * session and an expired refresh token all end a session WITHOUT wiping the
 * cache, and for a next user in the same workspace nothing else resets it
 * (workspace-choice.ts keeps the cache when the workspace is unchanged). That
 * user then delta-pulled from the previous user's cursor, and items, POs and
 * bundles outside their own warehouse scope stayed on the device (they are
 * only swept on FULL pulls), usable offline for scan lookups.
 *
 * So each pull records the account it pulled for (meta `cache_user_id`), and a
 * pull for any OTHER account first clears the cache and pulls in full. Checked
 * in the pull itself, which every path into a new session reaches, rather than
 * patched into each way a session can end.
 */

/** The meta key sync.ts stamps on every pull and db.ts clears with the cache. */
export const CACHE_USER_META_KEY = 'cache_user_id';

export type CacheOwnerAction =
  /** Nobody signed in, or the cache is this account's: nothing to do. */
  | 'keep'
  /** No owner recorded (pulled before owners were recorded, or just wiped):
   *  this account's next pull records itself. */
  | 'adopt'
  /** Another account's cache: clear it and pull this account's in full. */
  | 'reset';

export function cacheOwnerAction(
  storedOwner: string | null,
  liveUserId: string | null,
): CacheOwnerAction {
  if (!liveUserId) return 'keep';
  if (!storedOwner) return 'adopt';
  return storedOwner === liveUserId ? 'keep' : 'reset';
}
