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

/** MIME type every variant is encoded to, wherever the browser can do it. */
export const VARIANT_MIME = 'image/webp';

/**
 * What an engine that CANNOT encode WebP is asked for instead.
 *
 * WebKit (Safari, and in practice the browsers on iOS, which are built on it)
 * has no WebP encoder behind the canvas. Asked for `image/webp` it does not
 * fail: it silently answers with a PNG. Measured 2026-09-20 on Playwright's
 * WebKit 26.6 build on macOS, not on a shipping Safari: a 200 px thumbnail came
 * back as a 52 KB PNG against 8.5 KB of WebP in Chromium, and the PNG "master"
 * was never smaller than the JPEG it came from (20 of 20), so the uploader kept
 * the ORIGINAL file, uncapped. A production census is consistent with it: 67 of
 * one customer's 437 thumbnails are PNG bytes under a `-thumb.webp` name (p50
 * 71 KB against 8 KB), each with a PNG placeholder; 64 of those kept their
 * original JPEG as the master (up to 5.8 MB, 4 over 2048 px) and 3 have a PNG
 * master. JPEG is the one lossy format every canvas can write.
 */
export const FALLBACK_MIME = 'image/jpeg';

/**
 * Which type to ask the canvas for.
 *
 * The fallback is taken ONLY for a camera format: JPEG, HEIC or HEIF. None of
 * them carries transparency in a photo, so nothing the source had is given up.
 * (A HEIC is normally a JPEG already by this point, but only when the
 * `heic2any` transcode succeeded. When it fails, the original HEIC is passed on,
 * and WebKit, unlike other engines, can decode it; without this it would take
 * the PNG path again.) A PNG, WebP or AVIF source may be transparent, and JPEG
 * would paint that black, so those keep the old behaviour on such an engine:
 * the canvas is asked for WebP and answers with a PNG.
 */
const OPAQUE_SOURCE_TYPES: readonly string[] = ['image/jpeg', 'image/heic', 'image/heif'];

export function variantMimeFor(
  sourceType: string,
  canEncodeWebp: boolean,
): typeof VARIANT_MIME | typeof FALLBACK_MIME {
  if (canEncodeWebp) return VARIANT_MIME;
  return OPAQUE_SOURCE_TYPES.includes(sourceType) ? FALLBACK_MIME : VARIANT_MIME;
}

/**
 * Name for a re-encoded master. The extension follows what the encoder REALLY
 * returned (`blob.type`), not what it was asked for, so the stored object is
 * never a PNG called `.webp`. An unknown type keeps the historical `.webp`.
 */
export function variantFileName(sourceName: string, blobType: string): string {
  const baseName = sourceName.replace(/\.[^.]+$/, '') || 'image';
  const extension = blobType === 'image/jpeg' ? 'jpg' : blobType === 'image/png' ? 'png' : 'webp';
  return `${baseName}.${extension}`;
}

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
