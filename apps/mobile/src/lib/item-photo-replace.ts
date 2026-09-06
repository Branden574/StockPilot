import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@stockpilot/core';

/**
 * "Replace photo" on the mobile item screen (app/item/[id].tsx), as a
 * NON-DESTRUCTIVE-FIRST sequence.
 *
 * WHAT WENT WRONG (SP-078). The screen used to do this, inline, right after a
 * successful upload:
 *
 *     await supabase.storage.from('item-images').remove(oldPaths);
 *     await supabase.from('item_images').delete().eq('item_id', item.id);
 *     const { error: insErr } = await supabase.from('item_images').insert({…});
 *     if (insErr) { Alert.alert('Save failed', insErr.message); return; }
 *
 * Neither destructive result was checked and the insert had no compensation,
 * so two non-transactional orders both lost data on a flaky warehouse link:
 *
 *   (a) remove + delete succeed, the INSERT fails (connection drop, or RLS
 *       re-evaluated after a mid-session role change) -> the item ends with
 *       ZERO item_images rows, the old object is deleted for good, and the
 *       object we just uploaded is orphaned in the bucket. Web's list() and
 *       primaryImagesForItems find nothing; the item shows no photo anywhere.
 *   (b) the storage remove succeeds and the row DELETE errors -> execution
 *       fell straight through to the insert, leaving OLD rows pointing at
 *       DELETED objects. Web's primary resolver orders `is_primary desc,
 *       sort_order asc` (item-images.ts) and the stale row ties with the new
 *       one, so a list thumbnail can pick a dangling path whose signed URL
 *       404s.
 *
 * Nothing in the database stops this: item_images has no is_primary trigger or
 * unique constraint (0002), the write policy is `for all` to staff (0140) and
 * storage delete is granted to staff, so the client really can do the
 * destructive half first.
 *
 * WHAT STOPS IT NOW. Two ordering rules, both pinned by tests:
 *
 *   1. INSERT FIRST, with row proof (`.select('id').single()` — a 0-row write
 *      returning a null error is recurring bug pattern #2). Only once the new
 *      row exists is anything removed. If the insert fails, the ONLY thing
 *      cleaned up is the object we just uploaded; every existing row and
 *      object is left exactly as it was, so the item keeps the photo it had.
 *   2. DELETE ROWS BEFORE OBJECTS. A failure between them then leaves an
 *      invisible orphan object (nothing reads a bucket it has no row for),
 *      never a row pointing at nothing. The reverse order is failure (b).
 *
 * Neither cleanup step can fail the operation: the photo IS saved once the row
 * lands, so cleanup problems come back as `warnings` for the caller to log,
 * not as an error that would tell the user their photo did not save.
 *
 * WHAT ELSE CHANGED. The old code deleted EVERY item_images row for the item.
 * Web treats item images as a multi-image gallery (image-uploader.tsx renders
 * `images.map`, list() orders by sort_order), so replacing the photo from a
 * phone silently destroyed the other images of a 4-image gallery. This sweeps
 * only rows with `is_primary = true`, which is the one the phone is actually
 * replacing. The old comment noted the wipe also cleaned up legacy 0-byte
 * uploads from before the arrayBuffer fix; that incidental cleanup is gone on
 * purpose — bulk-deleting a user's gallery is too high a price, and any
 * remaining 0-byte rows want a one-off sweep, not a per-photo side effect.
 *
 * Injected client (never the module-level `supabase`) so this is testable in
 * the node vitest env — importing lib/supabase.ts pulls in expo-secure-store.
 */

export const ITEM_IMAGES_BUCKET = 'item-images';

export type ReplacePrimaryPhotoResult =
  /** The new row exists; `warnings` records any cleanup that did not finish. */
  | { ok: true; imageId: string; warnings: string[] }
  /** Nothing was changed except removing the just-uploaded object. */
  | { ok: false; error: string };

export async function replacePrimaryPhoto(args: {
  supabase: SupabaseClient<Database>;
  orgId: string;
  itemId: string;
  /** Storage path of the object the caller has ALREADY uploaded. */
  newPath: string;
}): Promise<ReplacePrimaryPhotoResult> {
  const { supabase, orgId, itemId, newPath } = args;
  const warnings: string[] = [];

  // 1) The row that makes the uploaded object findable, first.
  const { data: inserted, error: insErr } = await supabase
    .from('item_images')
    .insert({
      organization_id: orgId,
      item_id: itemId,
      storage_path: newPath,
      is_primary: true,
    })
    .select('id')
    .single();

  if (insErr || !inserted?.id) {
    // No row means nothing will ever reference this object — remove it rather
    // than leave paid-for bytes nobody can reach. Every EXISTING row and
    // object is deliberately untouched: the item keeps the photo it had.
    const { error: rmErr } = await supabase.storage.from(ITEM_IMAGES_BUCKET).remove([newPath]);
    if (rmErr) warnings.push(`orphan cleanup failed: ${rmErr.message}`);
    return { ok: false, error: insErr?.message ?? 'The photo could not be saved. Try again.' };
  }
  const imageId = inserted.id;

  // 2) Only the PREVIOUS primary rows are swept — never the whole gallery, and
  //    never the row we just wrote (hence the neq on its id).
  const { data: oldRows, error: oldErr } = await supabase
    .from('item_images')
    .select('id, storage_path')
    .eq('organization_id', orgId)
    .eq('item_id', itemId)
    .eq('is_primary', true)
    .neq('id', imageId);
  if (oldErr) {
    // Read failed closed: we do not know what to delete, so we delete nothing.
    // Two is_primary rows tie on `is_primary desc, sort_order asc`, which is a
    // cosmetic risk; guessing at a delete list is a data-loss one.
    warnings.push(`could not list the previous photo: ${oldErr.message}`);
    return { ok: true, imageId, warnings };
  }

  const previous = (oldRows ?? []) as { id: string; storage_path: string | null }[];
  if (previous.length === 0) return { ok: true, imageId, warnings };

  // 3) Rows before objects. If this errors we stop: the rows still point at
  //    objects that still exist, which renders correctly.
  const { error: delErr } = await supabase
    .from('item_images')
    .delete()
    .in(
      'id',
      previous.map((r) => r.id),
    );
  if (delErr) {
    warnings.push(`previous photo row not removed: ${delErr.message}`);
    return { ok: true, imageId, warnings };
  }

  const oldPaths = previous.map((r) => r.storage_path).filter((p): p is string => !!p);
  if (oldPaths.length > 0) {
    const { error: rmErr } = await supabase.storage.from(ITEM_IMAGES_BUCKET).remove(oldPaths);
    // Worst case here is an orphan object: no row references it any more, so
    // nothing renders it and nothing 404s. Surfaced, not fatal.
    if (rmErr) warnings.push(`previous photo file not removed: ${rmErr.message}`);
  }

  return { ok: true, imageId, warnings };
}
