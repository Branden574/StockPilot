import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { uploadObjectsStillNamed } from '@/server/services/upload-still-named';

/**
 * Which of `objects` (item-images storage paths) another item_images row in
 * the org still names, as its master or its thumb. Used by
 * ItemImagesService.remove() before it deletes a photo's files (L65b):
 * Duplicate copies an item's photo rows, not its files, so two items' rows can
 * name the same objects, and removing them broke the other item's photo.
 *
 * Read with the service-role client on purpose. The other row may belong to an
 * item the caller cannot read (a duplicate in another warehouse), which RLS
 * would hide, and the object would be deleted from under it. It lives outside
 * item-images.ts because that file's reads must all carry the caller-scoped
 * item embed. This read returns nothing about any other row: only the subset of
 * the caller's own paths that are shared, and it can only stop a delete, never
 * cause one.
 *
 * Org-scoped; excludes the row being removed. Null when the read fails: the
 * caller then removes no object, since an orphaned object is harmless and a
 * broken photo is not.
 */
export async function objectsNamedByOtherImageRows(
  organizationId: string,
  imageId: string,
  objects: readonly string[],
): Promise<Set<string> | null> {
  if (objects.length === 0) return new Set();
  try {
    const admin = createAdminClient();
    // Two small reads (a photo has at most a master and a thumb): rows of
    // this org, other than this one, naming any of the objects in either
    // column. Distinct values per column are all that is used.
    const read = (column: 'storage_path' | 'thumb_path') =>
      admin
        .from('item_images')
        .select(column)
        .eq('organization_id', organizationId)
        .neq('id', imageId)
        // in-list-bound: one photo's master and thumb, two paths at most
        .in(column, [...objects]);
    const [masters, thumbs] = await Promise.all([read('storage_path'), read('thumb_path')]);
    const failed = masters.error ?? thumbs.error;
    if (failed) throw new Error(failed.message);
    const named = new Set<string>();
    for (const row of (masters.data ?? []) as Array<{ storage_path: string | null }>) {
      if (row.storage_path) named.add(row.storage_path);
    }
    for (const row of (thumbs.data ?? []) as Array<{ thumb_path: string | null }>) {
      if (row.thumb_path) named.add(row.thumb_path);
    }
    return new Set(objects.filter((o) => named.has(o)));
  } catch (err) {
    void reportError(err, {
      tag: 'item_images.remove.shared_check',
      organizationId,
    });
    return null;
  }
}

/**
 * Part 6: whether any item_images row names one of `objects`, as its master
 * or its thumb (this photo recorded before, or a duplicated item's row).
 * Asked before a refused photo's objects are removed at its finalize, so a
 * refusal never removes a recorded photo's file. Service role, for the reason
 * above; here for the same reason too. Throws when the look fails: the caller
 * then removes nothing.
 */
export function itemImageObjectsNamed(objects: readonly string[]): Promise<boolean> {
  return uploadObjectsStillNamed('item_images', ['storage_path', 'thumb_path'], objects);
}
