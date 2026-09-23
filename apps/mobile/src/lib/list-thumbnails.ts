/**
 * Page-scoped thumbnail resolution for the Items and Books lists.
 *
 * Each list keeps a map of item id to signed URL for the rows it has shown,
 * where `null` means "resolved: this item has no photo", so a photoless row is
 * never asked about again until the next load.
 *
 * THE BUG THIS REPLACES. Both screens read item_images with one unbatched
 * `.in('item_id', ids)` and never read its `error`. A page can hold hundreds
 * of ids (a size-run page on Items), so the read could fail on URL length,
 * and then every id on the page was recorded as `null`, "no photo", until the
 * next full load. A photo that was there looked like no photo, silently.
 *
 * NOW: the read is batched (readPrimaryPhotos), and a failed read or a failed
 * signing round records NOTHING. The rows show their glyph for now, and the
 * next page view or pull-to-refresh asks again. A photo that exists but got no
 * signed URL is also left unresolved (never `null`), so it is retried rather
 * than remembered as missing.
 *
 * Pure: the screens pass in the reader and the signer (image-cache.ts imports
 * the Supabase client, so it must not be imported here).
 */

import { settleIdBatchRead, type IdBatchOutcome } from './id-batches';
import type { PhotoPaths } from './id-reads';

export type ThumbnailMap = ReadonlyMap<string, string | null>;

/**
 * Fold one resolution round into the map.
 *
 * - an item with no photo gets `null` (resolved, no photo);
 * - an item whose photo exists but got no signed URL is left OUT, so it stays
 *   unresolved and is asked about again;
 * - returns `prev` itself when nothing changes, so a round that resolves
 *   nothing new does not re-render (and does not re-run the effect).
 */
export function mergeResolvedThumbnails(
  prev: ThumbnailMap,
  requestedIds: readonly string[],
  photoByItem: ReadonlyMap<string, Pick<PhotoPaths, 'storage_path'>>,
  urlByPath: ReadonlyMap<string, string>,
): ThumbnailMap {
  let next: Map<string, string | null> | null = null;
  for (const id of requestedIds) {
    const photo = photoByItem.get(id);
    let value: string | null;
    if (!photo) {
      value = null;
    } else {
      const url = urlByPath.get(photo.storage_path);
      if (!url) continue;
      value = url;
    }
    if (prev.has(id) && prev.get(id) === value) continue;
    next ??= new Map(prev);
    next.set(id, value);
  }
  return next ?? prev;
}

/**
 * One resolution round for `requestedIds`: read the primary photos, sign them,
 * and return the state updater to apply. A failed read or signing round is a
 * failure outcome, and the caller records nothing.
 */
export async function resolveListThumbnails(
  requestedIds: readonly string[],
  readPhotos: (ids: readonly string[]) => Promise<ReadonlyMap<string, PhotoPaths>>,
  sign: (photos: PhotoPaths[]) => Promise<Map<string, string>>,
): Promise<IdBatchOutcome<(prev: ThumbnailMap) => ThumbnailMap>> {
  const read = await settleIdBatchRead(readPhotos(requestedIds));
  if (!read.ok) return read;
  const photoByItem = read.value;
  const signed =
    photoByItem.size > 0
      ? await settleIdBatchRead(sign(Array.from(photoByItem.values())))
      : { ok: true as const, value: new Map<string, string>() };
  if (!signed.ok) return signed;
  const urlByPath = signed.value;
  return {
    ok: true,
    value: (prev) => mergeResolvedThumbnails(prev, requestedIds, photoByItem, urlByPath),
  };
}
