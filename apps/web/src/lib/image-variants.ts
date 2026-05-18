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

/**
 * Detect runtime support for the Web Worker fast path.
 * Requires Worker + OffscreenCanvas + the structured-clone path for
 * Files (universally supported in browsers that have OffscreenCanvas).
 */
function canUseWorker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

/**
 * Try to compress via the Web Worker so the canvas encode happens
 * off the main thread. Resolves with the worker's variants, OR with
 * null when the worker fails (caller falls back to the main-thread
 * path). One worker per call — the Worker is short-lived and the
 * cleanest way to keep the protocol straightforward; for batch
 * uploads the parallel-fetch pool in the uploader already governs
 * concurrency.
 */
function compressInWorker(file: File): Promise<ImageVariants | null> {
  return new Promise<ImageVariants | null>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('./image-variants.worker.ts', import.meta.url),
        { type: 'module' },
      );
    } catch {
      resolve(null);
      return;
    }
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    worker.onmessage = (
      e: MessageEvent<
        | { ok: true; master: File; thumbBlob: Blob | null; lqip: string | null }
        | { ok: false; message: string }
      >,
    ) => {
      cleanup();
      if (e.data.ok) {
        resolve({
          master: e.data.master,
          thumbBlob: e.data.thumbBlob,
          lqip: e.data.lqip,
        });
      } else {
        resolve(null);
      }
    };
    worker.onerror = () => {
      cleanup();
      resolve(null);
    };
    worker.postMessage({ file });
  });
}

/**
 * Main-thread fallback. Same canvas operations as the worker; runs
 * on the UI thread (which is why the worker path is preferred). Used
 * when the worker fails, or when the browser doesn't support Worker
 * + OffscreenCanvas.
 */
async function compressOnMainThread(file: File): Promise<ImageVariants> {
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

/**
 * Detect a HEIC/HEIF source. iPhone Safari decodes these via canvas
 * natively (no transcode needed), but other browsers — and Safari
 * through canvas+OffscreenCanvas in some versions — cannot. Transcode
 * to JPEG via heic2any BEFORE the normal pipeline so the rest of the
 * code path stays browser-agnostic.
 *
 * The MIME check covers both the canonical types and the common
 * file-extension fallback (some uploaders strip the type metadata).
 */
function isHeicLike(file: File): boolean {
  const t = file.type.toLowerCase();
  if (t === 'image/heic' || t === 'image/heif') return true;
  const name = file.name.toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

async function transcodeHeicToJpeg(file: File): Promise<File> {
  // Dynamic import keeps the ~700 KB libheif WASM out of the initial
  // bundle — only iPhone-Safari users actually need it, and only on
  // first HEIC upload of the session.
  const { default: heic2any } = await import('heic2any');
  const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(result) ? result[0]! : result;
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${baseName}.jpg`, {
    type: 'image/jpeg',
    lastModified: file.lastModified,
  });
}

export async function compressImageVariants(file: File): Promise<ImageVariants> {
  // HEIC pre-step: turn the source into JPEG so the rest of the
  // pipeline (createImageBitmap → canvas) works across all browsers.
  // On native-HEIC browsers (current Safari) heic2any is harmless;
  // we just spend a couple extra hundred ms on the decode.
  let source = file;
  if (isHeicLike(file)) {
    try {
      source = await transcodeHeicToJpeg(file);
    } catch {
      // heic2any failure (typically very old browser without
      // WebAssembly) — let the downstream path try the original
      // file, which will fail decode and return the unmodified file
      // as `master` with no thumb/lqip. That at least preserves the
      // upload instead of dropping it on the floor.
    }
  }
  // Worker path: keeps the UI thread free during a 300-600ms encode.
  // Falls back to the main thread on any failure so uploads never
  // get stuck because of a worker hiccup (old browser, blocked
  // worker URL, postMessage timeout, etc).
  if (canUseWorker()) {
    const fromWorker = await compressInWorker(source);
    if (fromWorker) return fromWorker;
  }
  return compressOnMainThread(source);
}
