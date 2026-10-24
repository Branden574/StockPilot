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
 * The photo wipe runs whether or not the SQLite wipe succeeded: a SQLite
 * failure used to skip it.
 *
 * Best-effort: a cache that cannot be cleared is reported and never stops the
 * sign-out or the pull.
 */
export async function clearPhotoCaches(
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): Promise<void> {
  forgetSignedImageUrls();
  const results = await Promise.allSettled([Image.clearMemoryCache(), Image.clearDiskCache()]);
  results.forEach((result, i) => {
    const which = i === 0 ? 'memory' : 'disk';
    if (result.status === 'rejected') {
      warn(`[auth] could not clear the photo ${which} cache`, result.reason);
    } else if (result.value === false) {
      warn(`[auth] could not clear the photo ${which} cache`, null);
    }
  });
}

/**
 * Run a SQLite cache wipe, then clear the photo caches whether or not the
 * wipe succeeded. A wipe that fails is passed on unchanged, so its caller
 * reports it as before.
 */
export async function wipeWithPhotoCaches(wipe: () => Promise<void>): Promise<void> {
  try {
    await wipe();
  } finally {
    await clearPhotoCaches();
  }
}
