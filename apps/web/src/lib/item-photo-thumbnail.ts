import 'server-only';

import { withCappedImage } from './image-decode';
import { IMAGE_VARIANTS } from './image-variants.config';

/**
 * An item photo's thumbnail, made on the SERVER from the stored photo's bytes,
 * for the photos that were stored without one (docket B31: the thumbnail
 * backfill, api/admin/backfill-item-thumbs).
 *
 * It is the file the web uploader makes in the browser (image-variants.ts):
 * the longest edge IMAGE_VARIANTS.thumb.maxDimension, the aspect ratio kept,
 * never enlarged, WEBP at the thumbnail's quality. The photo's EXIF
 * orientation is applied first, so the thumbnail stands the way a browser
 * shows the photo; sharp writes no metadata unless asked, so none is kept.
 *
 * It replaces the backfill's earlier method, a Supabase on-demand transform of
 * the photo at 200 x 200 `cover`: that CROPPED every photo to a square (the
 * Items grid and the spreadsheet export draw the thumbnail whole, so a
 * backfilled photo lost its edges there), and each one was a billed,
 * rate-limited render.
 *
 * The decode is the capped decoder's (lib/image-decode.ts, S45): the bytes
 * must be a PNG, JPEG, WebP or AVIF within that format's pixel cap (50
 * million; AVIF 4096 x 4096), and it opens sharp with the EXIF orientation
 * applied. null when the bytes cannot be decoded (not one of those formats,
 * over the cap, or a file sharp's build cannot read).
 */

export async function makeItemPhotoThumbnail(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const edge = IMAGE_VARIANTS.thumb.maxDimension;
    const out = await withCappedImage(bytes, ['png', 'jpeg', 'webp', 'avif'], (img) =>
      img
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: Math.round(IMAGE_VARIANTS.thumb.quality * 100) })
        .toBuffer(),
    );
    if (out.byteLength === 0) return null;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return null;
  }
}
