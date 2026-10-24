import { Image } from 'expo-image';

import { forgetSignedImageUrls } from './image-cache';

/**
 * SIGN-OUT AND EVICTION: forget the photos the leaving account saw.
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
 * Now both the sign-out (auth-context.tsx, after the session is gone) and an
 * account eviction (use-account-gate.ts) clear expo-image's memory and disk
 * caches and the in-memory link cache. Best-effort: a cache that cannot be
 * cleared is reported and never stops the sign-out, which has already ended
 * the session.
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
