/**
 * Client-side image variant generation. Takes an uploader file and
 * returns three derived assets used by the inventory image pipeline:
 *
 *   • master    — full image capped at 2048px in WebP. Typical 2–10×
 *                 byte reduction from phone-camera JPEGs. Falls back
 *                 to the original file when WebP output is larger.
 *   • thumbBlob — 200px WebP for list-row thumbnails. null when
 *                 transcoding fails (very old browser, exotic source).
 *   • lqip      — 16px WebP encoded as a base64 data URL for use as
 *                 next/image's blurDataURL. Bounded at the 2000-char
 *                 DB constraint from migration 0122; oversize values
 *                 are returned as null so the row renders without a
 *                 blur placeholder.
 *
 * Shared by the item-detail image uploader (replacing an in-flight
 * photo) and the item-form staged-image flow (photos uploaded
 * alongside item creation) so both paths populate the same
 * thumb_path + lqip columns on item_images.
 */

const MAX_DIMENSION = 2048;
const THUMB_DIMENSION = 200;
const LQIP_DIMENSION = 16;
const WEBP_QUALITY = 0.85;
const THUMB_QUALITY = 0.8;
const LQIP_QUALITY = 0.5;
const LQIP_MAX_CHARS = 2000;

export interface ImageVariants {
  master: File;
  thumbBlob: Blob | null;
  lqip: string | null;
}

function fitWithin(width: number, height: number, maxDim: number) {
  if (width <= maxDim && height <= maxDim) return { w: width, h: height };
  if (width >= height) {
    return { w: maxDim, h: Math.round((height * maxDim) / width) };
  }
  return { h: maxDim, w: Math.round((width * maxDim) / height) };
}

async function bitmapToWebpBlob(
  bitmap: ImageBitmap,
  maxDim: number,
  quality: number,
): Promise<Blob | null> {
  const { w, h } = fitWithin(bitmap.width, bitmap.height, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

export async function compressImageVariants(file: File): Promise<ImageVariants> {
  if (typeof window === 'undefined' || typeof createImageBitmap !== 'function') {
    return { master: file, thumbBlob: null, lqip: null };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { master: file, thumbBlob: null, lqip: null };
  }
  try {
    const masterBlob = await bitmapToWebpBlob(bitmap, MAX_DIMENSION, WEBP_QUALITY);
    let master: File;
    if (masterBlob && masterBlob.size < file.size) {
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
      master = new File([masterBlob], `${baseName}.webp`, {
        type: 'image/webp',
        lastModified: file.lastModified,
      });
    } else {
      master = file;
    }

    // Thumb + LQIP run from the same bitmap — separate canvas draws,
    // no extra decode cost. Either may be null on toBlob failure
    // (very old browser, exotic source format) — the caller falls
    // back to the master + empty placeholder in that case.
    const thumbBlob = await bitmapToWebpBlob(bitmap, THUMB_DIMENSION, THUMB_QUALITY);
    const lqipBlob = await bitmapToWebpBlob(bitmap, LQIP_DIMENSION, LQIP_QUALITY);
    const lqip = lqipBlob ? await blobToDataUrl(lqipBlob) : null;
    return {
      master,
      thumbBlob,
      lqip: lqip && lqip.length <= LQIP_MAX_CHARS ? lqip : null,
    };
  } finally {
    bitmap.close();
  }
}
