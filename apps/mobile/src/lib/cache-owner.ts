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
 * pull for any OTHER account first clears the cache, and the photo caches with
 * it (photo-cache-wipe.ts), and pulls in full. Checked
 * in the pull itself, which every path into a new session reaches, rather than
 * patched into each way a session can end.
 *
 * "NO OWNER RECORDED" MEANS NOTHING OF ANOTHER ACCOUNT IS HERE (B18 review,
 * 2026-10-24). A pull that finds no record adopts the device as it is, rows,
 * photos and photo links included, so the record may be forgotten only where
 * the photos go too. A workspace switch, the workspace repair and Settings >
 * Offline cache > Clear (db.ts deleteOrgData) clear the rows and keep the
 * photos, and used to forget the record: until a pull landed and stamped it
 * again (the switch's pull is fire-and-forget and fails offline), a session
 * that then ended without a wipe let the next account adopt the previous
 * account's photos. Those three never change the account, so they now KEEP
 * the record, as they keep the photos. Kept, never re-stamped to whoever is
 * signed in at the wipe: the repair also runs inside the NEXT account's own
 * sign-in (a fallback sign-out keeps the saved workspace, which need not be
 * the next account's), before its first pull, while the photos are still the
 * previous account's.
 *
 * Not by clearing the photos at those three instead: expo-image keeps ONE
 * memory and disk cache for the whole app, so every workspace switch would
 * drop every photo of every workspace and download them again, for the people
 * who switch most. Their photos are still their own.
 *
 * The record changes in three places only, each once nothing of the account
 * it named is left:
 *   - a pull that landed records the account it pulled for (sync.ts);
 *   - the reset below records the new account once the previous one's photos,
 *     photo links and rows are gone, before its pull is sent, so a pull that
 *     then fails does not reset again at every tick and wipe what the new
 *     account has cached since (a count opened to work on offline);
 *   - a sign-out and an eviction forget it, in the SQLite wipe that runs after
 *     the photo wipe (photo-cache-wipe.ts): an app closed while the photos
 *     were being cleared still names the account, and the next one clears
 *     them again.
 */

/** The meta key sync.ts stamps on every pull. Only the wipes that clear the
 *  photos first (a sign-out, an eviction) forget it (db.ts). */
export const CACHE_USER_META_KEY = 'cache_user_id';

export type CacheOwnerAction =
  /** Nobody signed in, or the cache is this account's: nothing to do. */
  | 'keep'
  /** No owner recorded: pulled before owners were recorded, or emptied with
   *  its photos by a sign-out or an eviction. This account's next pull
   *  records itself. */
  | 'adopt'
  /** Another account's cache: clear it and its photos, record this account,
   *  and pull this account's in full. */
  | 'reset';

export function cacheOwnerAction(
  storedOwner: string | null,
  liveUserId: string | null,
): CacheOwnerAction {
  if (!liveUserId) return 'keep';
  if (!storedOwner) return 'adopt';
  return storedOwner === liveUserId ? 'keep' : 'reset';
}
