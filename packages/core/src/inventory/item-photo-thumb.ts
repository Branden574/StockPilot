/**
 * The small copy stored next to every item photo (item_images.thumb_path).
 *
 * Lists draw an item's photo small: 28 px cells on the web, 40-56 pt rows on
 * the phone. Each list signs the stored thumbnail when the row has one, so a
 * photo without one costs every list more: the web signs the full-size master,
 * the phone's Items, Books and rentals lists ask Supabase to resize the master
 * on demand (billed per photo each month), and the phone's order catalog
 * downloads the master itself (about 400 KB a photo).
 *
 * The web makes its thumbnail in the browser with the numbers in
 * apps/web/src/lib/image-variants.config.ts. The phone makes its own with the
 * numbers here. That config must import nothing (it is bundled into a Web
 * Worker), so it cannot read this file; instead
 * apps/web/src/lib/image-variants.parity.test.ts fails when the two differ.
 */
export const ITEM_PHOTO_THUMB = {
  /** Longest edge, in pixels. The aspect ratio is kept and a photo is never enlarged. */
  maxEdge: 200,
  /** Lossy quality, 0 to 1. */
  quality: 0.8,
} as const;

/**
 * The size to draw a thumbnail at, for a photo of `width` x `height` pixels:
 * the longest edge ITEM_PHOTO_THUMB.maxEdge and the aspect ratio kept, in
 * whole pixels (at least 1). A photo that already fits keeps its own size: it
 * is never enlarged. The same arithmetic as the web's fitWithin.
 */
export function itemPhotoThumbSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const max = ITEM_PHOTO_THUMB.maxEdge;
  if (width <= max && height <= max) return { width, height };
  if (width >= height) {
    return { width: max, height: Math.max(1, Math.round((height * max) / width)) };
  }
  return { width: Math.max(1, Math.round((width * max) / height)), height: max };
}

/**
 * The format the phone encodes a thumbnail in, from its master's extension.
 *
 * JPEG for a JPEG master. Every camera photo is one by then, and so is every
 * photo the phone had to shrink (lib/image-resize.ts writes JPEG). Anything
 * else is a small PNG or WEBP the phone kept as it was, which may be
 * transparent, and JPEG would paint a transparent background black: those get
 * a PNG, the reason the web keeps WEBP or PNG for such a source
 * (variantMimeFor in image-variants.config.ts).
 */
export function itemPhotoThumbFormat(masterExt: string): 'jpg' | 'png' {
  const ext = masterExt.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'jpg' : 'png';
}
