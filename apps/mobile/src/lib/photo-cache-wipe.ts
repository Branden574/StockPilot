import { Image } from 'expo-image';

import { forgetSignedImageUrls } from './image-cache';

/**
 * WHEN AN ACCOUNT LEAVES THE DEVICE: forget the photos it saw.
 *
 * THE DEFECT. Every item photo and proof-of-delivery photo is drawn through
 * expo-image with a memory and disk cache keyed by its storage path
 * (components/ui/cached-image.tsx), and the item-photo links are kept in
 * memory for the session (image-cache.ts). A sign-out cleared the SQLite cache
 * only (db.ts wipeForSignOut), so on a shared phone the previous account's
 * delivery photos and item photos stayed in the app's image cache on disk (up
 * to a week, SDWebImage's default expiry, which the app does not change), and
 * its signed photo links stayed in memory until the app was closed.
 *
 * Now the photos go wherever the SQLite cache goes because the account
 * changed, through wipeWithPhotoCaches:
 *   - the sign-out (auth-context.tsx, once the session is gone);
 *   - an account eviction (use-account-gate.ts);
 *   - a pull for another account (sync.ts, cache-owner.ts). "Use password
 *     instead", "Use a different account", a session revoked elsewhere and
 *     an expired refresh token end a session without a wipe, and the next
 *     account's first pull is the one place all of them reach. Signing back
 *     in as the same account keeps its own photos, as it keeps its cache.
 * The SQLite wipe runs whether or not the photo wipe succeeded, and the photo
 * wipe whether or not the SQLite one does: a SQLite failure used to skip it.
 *
 * And a pull that finds no owner recorded clears the photos on their own
 * (clearPhotoCaches, sync.ts): it cannot tell whose they are, an older
 * release's wipes having forgotten the record and kept them, and it keeps the
 * rows until its full pull sorts them (marked unconfirmed, not wiped), so no
 * SQLite wipe runs there (cache-owner.ts).
 *
 * WHICH WIPES, AND IN WHICH ORDER (B18 reviews, 2026-10-24). That next pull
 * resets only a cache recorded as ANOTHER account's; one with no record keeps
 * its rows (cache-owner.ts). So:
 *   - only these account changes, and that pull, clear the photos. A
 *     workspace switch, the workspace repair and Settings > Offline cache >
 *     Clear keep the account, its photos and the record of whose they are
 *     (db.ts deleteOrgData). They used to forget the record, and the next
 *     account then adopted the previous one's photos;
 *   - the photos go FIRST, then the SQLite wipe. The sign-out's and the
 *     eviction's wipes forget the record: run before the photo wipe, as they
 *     were, an app closed while the disk cache was still being cleared
 *     (expo-image clears it in the background and answers once it has
 *     finished) left photos with no owner recorded. Now the record is
 *     forgotten only once the photos are gone, the reset records the new
 *     account only after both, and the pull with no owner recorded records
 *     its account only after the photos.
 *
 * Best-effort: a cache that cannot be cleared is reported and never stops the
 * sign-out or the pull.
 *
 * AND IT SAYS WHETHER IT WORKED (B18 review of 43256f0da). It answered
 * nothing, so a pull recorded whose cache this is after a clear that had
 * failed (expo-image answering false, or rejecting), every later pull kept,
 * and the photos were never cleared. The reset and the adopt now record the
 * account only on true (sync.ts, cache-owner.ts), and on false leave no record,
 * so the next pull clears again. True only when the photo links were forgotten
 * and BOTH clears answered true; a rejection, a false, any other answer, or a
 * native call that throws as it is called is a failure, warned as before.
 */
export async function clearPhotoCaches(
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): Promise<boolean> {
  let cleared = true;
  try {
    forgetSignedImageUrls();
  } catch (err) {
    cleared = false;
    warn('[auth] could not forget the photo links', err);
  }
  // Each call made inside an async function, so one that throws as it is
  // called (a native module missing from the binary) is a rejection like any
  // other and never escapes: the pull that clears photos with no SQLite wipe
  // is never skipped by a throw here (sync.ts).
  const results = await Promise.allSettled([
    (async () => Image.clearMemoryCache())(),
    (async () => Image.clearDiskCache())(),
  ]);
  results.forEach((result, i) => {
    const which = i === 0 ? 'memory' : 'disk';
    if (result.status === 'rejected') {
      cleared = false;
      warn(`[auth] could not clear the photo ${which} cache`, result.reason);
    } else if (result.value !== true) {
      cleared = false;
      warn(`[auth] could not clear the photo ${which} cache`, null);
    }
  });
  return cleared;
}

/**
 * Clear the photo caches, then run a SQLite cache wipe, whatever became of
 * the photo wipe, and answer whether the photos were cleared (clearPhotoCaches).
 * A SQLite wipe that fails is passed on unchanged, so its caller reports it as
 * before. Photos first: see the header. The `finally` stays although
 * clearPhotoCaches no longer throws: nothing here may ever skip the SQLite wipe.
 */
export async function wipeWithPhotoCaches(wipe: () => Promise<void>): Promise<boolean> {
  let photosCleared = false;
  try {
    photosCleared = await clearPhotoCaches();
  } finally {
    await wipe();
  }
  return photosCleared;
}
