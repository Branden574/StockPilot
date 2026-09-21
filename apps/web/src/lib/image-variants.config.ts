/**
 * The ONE place the upload image-variant settings live.
 *
 * Every photo uploaded on the web is turned into three files in the browser:
 * a MASTER, a THUMB and a tiny LQIP. Two code paths do that work: a Web Worker
 * (`image-variants.worker.ts`, what every modern browser runs) and a
 * main-thread fallback (`image-variants.ts`, for browsers without Worker +
 * OffscreenCanvas, or when the worker fails). Each used to carry its own copy
 * of these numbers, and the copies drifted: on 2026-07-01 the fallback's thumb
 * went to 400 px while the worker stayed at 200 px, so the change never reached
 * a real upload (production census 2026-09-18: every thumbnail is 200 px or
 * smaller, including all of those uploaded after that date).
 *
 * Both paths import from here now, and `image-variants.parity.test.ts` fails if
 * either one grows a private copy again.
 *
 * WHY THE THUMB IS 200 PX. For item photos it is drawn in 28 x 28 CSS px cells
 * (the Items, Books and rentals lists, the command palette, purchase-order
 * lines): 84 device px at 3x, so 200 already oversupplies them. The larger
 * cells the 2026-07-01 note was written for (order storefront, public catalog,
 * item cards) have since moved to the master. Measured with Chromium's own
 * encoder (n=40, quality 0.8), a 400 px thumb weighs 2.1x a 200 px one (17.9 KB
 * against 8.5 KB at p50), and no 28 px cell could display the difference.
 *
 * KNOWN EXCEPTION: the maintenance request photo grids reuse this generator
 * (`maintenance-photos-panel.tsx`, a different bucket) and show its thumb in
 * tiles of roughly 96 x 150 CSS px on the web and 72 pt on mobile, where 200 px
 * IS upscaled on a retina screen. The worker has always sent 200 px there, and
 * the mobile app sends 400 px for the same grid. That surface wants a size of
 * its own, chosen with a side-by-side at DPR 2 and 3; a larger pre-generated
 * tier, for it or for grids, gets its own name. It is not this number.
 *
 * KEEP THIS MODULE INERT: constants and pure functions only. It is bundled into
 * the worker as well as the page, so it must not import anything, touch the
 * DOM, or read `window` / `self`.
 */

export const IMAGE_VARIANTS = {
  /** Full image, WebP, longest side capped. Kept as the original file when WebP comes out larger. */
  master: { maxDimension: 2048, quality: 0.85 },
  /** List-row thumbnail, WebP, aspect preserved, never upscaled. */
  thumb: { maxDimension: 200, quality: 0.8 },
  /**
   * Blur placeholder, WebP, inlined as a base64 data URL. `maxChars` is the
   * `item_images_lqip_size_chk` constraint (migration 0122): a longer value is
   * dropped rather than sent, and the row renders without a placeholder.
   */
  lqip: { maxDimension: 16, quality: 0.5, maxChars: 2000 },
  /** HEIC / HEIF sources are turned into JPEG at this quality BEFORE the variants are made. */
  heicTranscodeQuality: 0.92,
} as const;

/** MIME type every variant is encoded to. */
export const VARIANT_MIME = 'image/webp';

/**
 * Largest size with the same aspect ratio whose longest side is `maxDim`.
 * Never enlarges: a source already inside the box is returned unchanged.
 */
export function fitWithin(width: number, height: number, maxDim: number): { w: number; h: number } {
  if (width <= maxDim && height <= maxDim) return { w: width, h: height };
  if (width >= height) {
    return { w: maxDim, h: Math.round((height * maxDim) / width) };
  }
  return { h: maxDim, w: Math.round((width * maxDim) / height) };
}
