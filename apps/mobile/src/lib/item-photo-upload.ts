import type { SupabaseClient } from '@supabase/supabase-js';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

import {
  ITEM_PHOTO_THUMB,
  itemPhotoPath,
  itemPhotoThumbFormat,
  itemPhotoThumbPath,
  itemPhotoThumbSize,
  randomPhotoFileBase,
  type Database,
} from '@stockpilot/core';

import { resizeForUpload } from './image-resize';
import { ITEM_IMAGES_BUCKET } from './item-photo-replace';

/**
 * ONE item photo from the phone into the `item-images` bucket: the photo
 * itself (the master) and, next to it, its thumbnail. The three phone
 * uploaders (new item, replace photo on the item screen, scan capture) all
 * call this, then write the item_images row with BOTH paths:
 *
 *     storage_path: upload.path, thumb_path: upload.thumbPath
 *
 * ═══ WHY THE PHONE MAKES THE THUMBNAIL (docket B31) ═══
 *
 * Until this, a photo taken on the phone had no thumbnail (thumb_path null),
 * so every list paid for its full-size master instead: the web signed the
 * master, the phone's Items, Books and rentals lists asked Supabase to resize
 * it on demand (billed per photo each month, image-cache.ts), and the phone's
 * order catalog downloaded the master itself.
 *
 * The phone, not the server, makes it, because that is how the item photo
 * pipeline already works:
 *   - the web makes its thumbnail in the browser (lib/image-variants.ts) and
 *     uploads it next to the master; the server only records the path;
 *   - the phone has no server step at all: it uploads straight to the bucket
 *     and inserts the row itself, under the 0381 policies, which already
 *     accept a thumbnail in the master's item folder;
 *   - maintenance photos are different (B29 had the server make theirs)
 *     because their finalize step already reads and re-encodes the whole
 *     photo on the server for privacy; item photos have no such step, and
 *     adding one would mean a new endpoint, a download and a re-encode on the
 *     server for every phone photo.
 * expo-image-manipulator is already in the app (image-resize.ts), so this
 * ships by OTA.
 *
 * ═══ WHAT IS MADE ═══
 *
 * The web thumbnail's size from core (ITEM_PHOTO_THUMB: 200 px longest edge,
 * aspect kept, never enlarged, quality 0.8), drawn from the photo that was
 * uploaded, so it always shows the same picture. JPEG for a JPEG master, PNG
 * for a PNG or WEBP one, which may be transparent (itemPhotoThumbFormat). It
 * is named `{base}-thumb.{jpg|png}` beside `{base}.{ext}` (core
 * itemPhotoThumbPath), so the name says what the bytes are.
 *
 * ═══ A THUMBNAIL NEVER COSTS THE PHOTO ═══
 *
 * It is made only after the master is stored, and anything that goes wrong
 * with it (the size probe, the encode, its upload) answers `thumbPath: null`:
 * the row is then written exactly as before, and every list falls back to the
 * master as it does today. Phones on older updates send no thumbnail at all
 * and keep working unchanged.
 *
 * ═══ ALSO: ONLY FORMATS THE BUCKET TAKES ═══
 *
 * The bucket accepts PNG, JPEG, WEBP, AVIF and HEIC (migration 0046), and
 * resizeForUpload hands back a small GIF from the photo library unchanged
 * (expo-image-picker keeps a GIF as .gif), which every phone uploader then
 * sent as image/gif and the bucket refused. A GIF is turned into a JPEG
 * first.
 *
 * Injected client (never the module-level `supabase`), so this runs in the
 * node vitest env.
 */

/** The extensions the bucket accepts that the phone can produce (0046). */
export const ITEM_PHOTO_UPLOAD_EXTENSIONS: readonly string[] = ['jpg', 'png', 'webp'];

const MIME_FOR_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type ItemPhotoUpload =
  /** The master is stored at `path`; `thumbPath` is its thumbnail, or null when none was stored. */
  | { ok: true; path: string; thumbPath: string | null }
  /** The master upload was refused or failed: nothing was stored. */
  | { ok: false; error: string };

/** The bytes of a local file. NOT `fetch(uri).blob()`: in React Native that
 *  uploads a 0-byte object (reference_mobile_image_push_gotchas). */
async function readFileBytes(uri: string): Promise<ArrayBuffer> {
  return await (await fetch(uri)).arrayBuffer();
}

/** The photo's size in pixels, or null when it cannot be read. */
function imageSize(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve(width > 0 && height > 0 ? { width, height } : null),
      () => resolve(null),
    );
  });
}

/** Resized for upload (image-resize.ts), in a format the bucket accepts. */
async function prepareItemPhoto(uri: string): Promise<{ uri: string; ext: string }> {
  const resized = await resizeForUpload(uri);
  const ext = resized.ext === 'jpeg' ? 'jpg' : resized.ext.toLowerCase();
  if (ITEM_PHOTO_UPLOAD_EXTENSIONS.includes(ext)) return { uri: resized.uri, ext };
  const converted = await ImageManipulator.manipulateAsync(resized.uri, [], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return { uri: converted.uri, ext: 'jpg' };
}

/**
 * Make the thumbnail of the photo at `uri` (already uploaded as `{base}.{ext}`)
 * and store it beside it. The stored path, or null for any failure: see "A
 * THUMBNAIL NEVER COSTS THE PHOTO".
 */
async function storeThumbnail(
  supabase: SupabaseClient<Database>,
  args: { orgId: string; itemId: string; base: string; uri: string; ext: string },
): Promise<string | null> {
  try {
    const dims = await imageSize(args.uri);
    if (!dims) {
      console.warn('[item photo] thumbnail skipped: the photo size could not be read');
      return null;
    }
    const size = itemPhotoThumbSize(dims.width, dims.height);
    const fits = size.width === dims.width && size.height === dims.height;
    const format = itemPhotoThumbFormat(args.ext);
    const thumb = await ImageManipulator.manipulateAsync(args.uri, fits ? [] : [{ resize: size }], {
      compress: ITEM_PHOTO_THUMB.quality,
      format: format === 'png' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
    });
    const thumbPath = itemPhotoThumbPath(args.orgId, args.itemId, args.base, format);
    const bytes = await readFileBytes(thumb.uri);
    const { error } = await supabase.storage
      .from(ITEM_IMAGES_BUCKET)
      .upload(thumbPath, bytes, { contentType: MIME_FOR_EXT[format] });
    if (error) {
      console.warn('[item photo] thumbnail upload failed:', error.message);
      return null;
    }
    return thumbPath;
  } catch (e) {
    console.warn('[item photo] thumbnail not made:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Upload one picked or captured photo of an item: the master, then its
 * thumbnail. Writes no row: the caller inserts it with both paths. A failure
 * to read or resize the photo throws, as it did inline before; a refused
 * master upload answers `{ ok: false }`.
 */
export async function uploadItemPhoto(args: {
  supabase: SupabaseClient<Database>;
  orgId: string;
  itemId: string;
  /** The local file the picker or camera returned. */
  uri: string;
}): Promise<ItemPhotoUpload> {
  const { supabase, orgId, itemId } = args;
  // Phone-camera photos are typically 4000 x 3000 (3-5 MB); the bucket only
  // stores list-friendly sizes (image-resize.ts).
  const photo = await prepareItemPhoto(args.uri);
  const base = randomPhotoFileBase();
  // The one path builder every writer uses; the database (0381) refuses any
  // other shape (packages/core item-photo-path.test.ts pins it).
  const path = itemPhotoPath(orgId, itemId, `${base}.${photo.ext}`);
  const bytes = await readFileBytes(photo.uri);
  const { error } = await supabase.storage
    .from(ITEM_IMAGES_BUCKET)
    .upload(path, bytes, { contentType: MIME_FOR_EXT[photo.ext] ?? 'image/jpeg' });
  if (error) return { ok: false, error: error.message };
  const thumbPath = await storeThumbnail(supabase, {
    orgId,
    itemId,
    base,
    uri: photo.uri,
    ext: photo.ext,
  });
  return { ok: true, path, thumbPath };
}
