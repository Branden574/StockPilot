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
 * the pull is sent. Recorded before the pull is sent, not when one lands: an
 * account whose pulls kept failing (a timeout on weak Wi-Fi, a 500) was never
 * recorded while it drew photos the screens sign straight from storage and
 * cached the counts it opened, and after its session ended without a wipe the
 * next account adopted them too.
 *
 * NOR THE ROWS (B18 review of 43256f0da). That pull used to keep the rows, the
 * delta cursor and the persisted scope, permissions and modules, on the
 * reasoning that every wipe that forgot the record emptied the rows too. Not
 * so: the older release's switch, repair and Clear erased the record while
 * rows cached after them stayed (a count opened before the next pull landed),
 * and any later path that loses the record would leave them all. The next
 * account then delta-pulled from that cursor, on someone else's timeline, and
 * items, POs and counts outside its scope were never swept (only a full pull
 * sweeps them). So the pull that adopts forgets the cursor and the persisted
 * values, and marks every cached row UNCONFIRMED (db.ts markCacheUnconfirmed),
 * and pulls in full; that pull keeps what it returns for this account, and a
 * count only while this account still has an unsent entry for it in the
 * outbox (sync.ts). Marked, not deleted: offline nothing is pulled, and a delete would
 * take this account's own count, opened before its first pull, with it.
 *
 * A PHOTO CLEAR THAT FAILED IS STILL OWED, AND RECORDED AS SUCH (B18 reviews
 * of 43256f0da and 254fb9c72). The clear is best-effort (expo-image answers
 * false, or rejects; photo-cache-wipe.ts says which). Recording the account
 * after one that failed, as if it had worked, meant every later pull kept,
 * and the photos were never cleared. Leaving the record absent instead, so
 * that the next pull adopted and cleared again, was worse: by then the
 * cache held this account's freshly pulled rows, and "no record" is the
 * adopt's answer for ANY account. After this account's session ended without
 * a wipe, the next account's pull adopted those rows instead of resetting
 * them, and an adopt only marks rows: offline nothing is pulled, so that
 * account read this one's items (on hand, unit cost), purchase orders and
 * counts until a full pull of its own landed. And while the clear kept
 * failing, every tick adopted again, forgetting this account's own cursor
 * and persisted values and pulling in full.
 * So the reset and the adopt record the account whatever the clear did, and
 * a clear that failed is recorded beside it (`cache_photos_pending`, in the
 * same write, db.ts setCacheOwner). Any other account still finds another
 * owner recorded and resets, which wipes the rows at once, offline too, and
 * clears the photos. This account's own pulls find the clear owed and clear
 * the photos again, and do nothing else, until a clear works ('clear-photos'
 * below; db.ts markPhotosCleared then forgets it).
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
 *   - the reset below records the new account once the previous one's rows
 *     are gone and its photo clear has answered, before its pull is sent, so
 *     a pull that then fails does not reset again at every tick and wipe what
 *     the new account has cached since (a count opened to work on offline);
 *     with the clear owed when it failed;
 *   - a pull that finds no record records its account once the photo clear
 *     has answered, before its pull is sent, so the next account's pull
 *     resets what this one left even if none of its pulls lands, and a later
 *     tick does not clear its photos again; with the clear owed when it
 *     failed;
 *   - a pull that landed records the account it pulled for (sync.ts), which
 *     the two above have already recorded;
 *   - a sign-out and an eviction forget it, and any clear owed with it, in the
 *     SQLite wipe that runs after the photo wipe (photo-cache-wipe.ts): an app
 *     closed while the photos were being cleared still names the account, and
 *     the next one clears them again. They forget it whatever the photo clear
 *     did: with no record, the next account's pull clears the photos again.
 * The first two write the record only after the clear has answered, so an app
 * closed during the clear clears them again at its next pull. A clear owed is
 * forgotten only by those two exits, by a reset or an adopt whose own clear
 * worked, and by this account's own retry once it works, so an app closed
 * during the retry tries again too.
 */

/**
 * The `last_synced_at` stamp of a cached row no pull for the recorded account
 * has confirmed: every row a pull that found no owner recorded found on the
 * device (db.ts markCacheUnconfirmed). Every pull stamps what it returns with
 * its own time, and the count screen stamps what it caches with the time it
 * did, both later than 0, so the full pull that follows the adopt keeps a row
 * still stamped 0 only for a count this account has an unsent entry for
 * (sync.ts). A stamp of 0, not "older than this pull": a phone whose clock ran
 * ahead when the rows were cached would date them after the pull.
 */
export const UNCONFIRMED_ROW_STAMP = 0;

/** The meta key sync.ts stamps on every pull. Only the wipes that clear the
 *  photos first (a sign-out, an eviction) forget it (db.ts). */
export const CACHE_USER_META_KEY = 'cache_user_id';

/** Written with the owner record when the photo clear at a reset or an adopt
 *  failed (its value: the account recorded with it), and deleted when a later
 *  clear works (db.ts setCacheOwner, markPhotosCleared). Any value at all
 *  means a clear is owed: one an older release left beside another owner is
 *  cleared off too, rather than trusted. */
export const PHOTOS_PENDING_META_KEY = 'cache_photos_pending';

export type CacheOwnerAction =
  /** Nobody signed in, or the cache is this account's: nothing to do. */
  | 'keep'
  /** The cache is this account's, but the photo clear at its reset or its
   *  adopt failed, so earlier accounts' photos may still be on the device.
   *  The photos and photo links are cleared again, and nothing else: no row
   *  is marked or wiped, no value forgotten, no reader refreshed and no full
   *  pull forced. Until a clear works, at every pull, offline too. */
  | 'clear-photos'
  /** No owner recorded: a fresh install, a cache a sign-out or an eviction
   *  emptied after clearing its photos, or one an older release left with
   *  anyone's photos and rows. The photos and photo links are cleared, the
   *  cursor and the persisted values forgotten, the rows marked unconfirmed,
   *  and this account recorded (with the clear owed if it failed), before its
   *  pull is sent in full. */
  | 'adopt'
  /** Another account's cache: clear it and its photos, record this account
   *  (with the clear owed if it failed), and pull this account's in full. */
  | 'reset';

export function cacheOwnerAction(
  storedOwner: string | null,
  liveUserId: string | null,
  /** A photo clear is owed (PHOTOS_PENDING_META_KEY is set). */
  photoClearOwed = false,
): CacheOwnerAction {
  if (!liveUserId) return 'keep';
  if (!storedOwner) return 'adopt';
  if (storedOwner !== liveUserId) return 'reset';
  return photoClearOwed ? 'clear-photos' : 'keep';
}
