import 'server-only';

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
 * `sharp` is a dependency of apps/web, loaded lazily as in image-reencode.ts.
 * null when the bytes cannot be decoded (not an image, a format sharp's build
 * cannot read, or more than MAX_INPUT_PIXELS).
 */

/** A decode past this many pixels is refused: a decompression bomb, not a
 *  photo. The limit image-reencode.ts measured and chose (a 50 MP decode
 *  stays near 1 GB). sharp checks it from the header, before decoding. */
const MAX_INPUT_PIXELS = 50_000_000;

export async function makeItemPhotoThumbnail(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const edge = IMAGE_VARIANTS.thumb.maxDimension;
    const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      // rotate() with no angle applies the EXIF orientation to the pixels.
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: Math.round(IMAGE_VARIANTS.thumb.quality * 100) })
      .toBuffer();
    if (out.byteLength === 0) return null;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return null;
  }
}
