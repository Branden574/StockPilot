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
 * NO OWNER RECORDED: THE PHOTOS CAN BE ANYONE'S (B18 reviews, 2026-10-24). A
 * pull that finds no record cannot tell whose photos are on the device. This
 * release forgets the record only once the photos are gone (a sign-out, an
 * eviction), but the release before it forgot the record at every wipe and
 * cleared the photos at none, so a phone it left can hold any account's. So
 * that pull clears the photos and photo links, and records its account before
 * the pull is sent. Not the rows: every wipe that forgot the record emptied
 * them too, and what was cached since is normally this account's own (a count
 * it opened before this pull). Recorded before the pull is sent, not when one
 * lands: an account whose pulls kept failing (a timeout on weak Wi-Fi, a 500)
 * was never recorded while it drew photos the screens sign straight from
 * storage and cached the counts it opened, and after its session ended
 * without a wipe the next account adopted them too.
 *
 * A WIPE THAT KEEPS THE PHOTOS KEEPS THE RECORD. A workspace switch, the
 * workspace repair and Settings > Offline cache > Clear (db.ts deleteOrgData)
 * clear the rows and keep the photos, and used to forget the record: until a
 * pull landed and stamped it again (the switch's pull is fire-and-forget and
 * fails offline), a session that then ended without a wipe let the next
 * account adopt the previous account's photos, and the counts it opened
 * since. Those three never change the account, so they KEEP the record, as
 * they keep the photos (forgotten there, the same account's next pull would
 * also clear its own photos at every switch). Kept, never re-stamped to
 * whoever is signed in at the wipe: the repair also runs inside the NEXT
 * account's own sign-in (a fallback sign-out keeps the saved workspace, which
 * need not be the next account's), before its first pull, while the photos
 * are still the previous account's.
 *
 * Not by clearing the photos at those three instead: expo-image keeps ONE
 * memory and disk cache for the whole app, so every workspace switch would
 * drop every photo of every workspace and download them again, for the people
 * who switch most. Their photos are still their own.
 *
 * The record changes in four places only:
 *   - the reset below records the new account once the previous one's photos,
 *     photo links and rows are gone, before its pull is sent, so a pull that
 *     then fails does not reset again at every tick and wipe what the new
 *     account has cached since (a count opened to work on offline);
 *   - a pull that finds no record records its account once the photos and
 *     photo links are gone, before its pull is sent, so the next account's
 *     pull resets what this one left even if none of its pulls lands, and a
 *     later tick does not clear its photos again;
 *   - a pull that landed records the account it pulled for (sync.ts), which
 *     the two above have already recorded;
 *   - a sign-out and an eviction forget it, in the SQLite wipe that runs after
 *     the photo wipe (photo-cache-wipe.ts): an app closed while the photos
 *     were being cleared still names the account, and the next one clears
 *     them again.
 * The first two record the account only after the photos are gone, so an app
 * closed during the clear clears them again at its next pull.
 */

/** The meta key sync.ts stamps on every pull. Only the wipes that clear the
 *  photos first (a sign-out, an eviction) forget it (db.ts). */
export const CACHE_USER_META_KEY = 'cache_user_id';

export type CacheOwnerAction =
  /** Nobody signed in, or the cache is this account's: nothing to do. */
  | 'keep'
  /** No owner recorded: a fresh install, a cache a sign-out or an eviction
   *  emptied after clearing its photos, or one an older release left with
   *  anyone's photos. The photos and photo links are cleared, the rows kept,
   *  and this account recorded, before its pull is sent. */
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
