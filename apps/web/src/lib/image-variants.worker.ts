/// <reference lib="webworker" />

/**
 * Web worker that runs the same master / thumb / LQIP transcode the
 * main-thread `compressImageVariants` does — but off the UI thread so
 * the page stays responsive while a batch of phone-camera photos
 * compresses (each ~10 MB original = ~300-600ms of canvas work).
 *
 * Protocol:
 *   in:  { file: File }
 *   out (ok):    { ok: true; master: File; thumbBlob: Blob | null; lqip: string | null }
 *   out (error): { ok: false; message: string }
 *
 * Requires Worker + OffscreenCanvas + createImageBitmap, all of which
 * exist in Chrome 69+, Firefox 105+, Safari 16.4+. The caller checks
 * support and falls back to the main-thread path when unavailable.
 *
 * The sizes and qualities come from `image-variants.config.ts`, the same
 * module the main-thread path imports. The import is RELATIVE on purpose: that
 * form was verified to be bundled into the worker's chunk by a Next 16 /
 * Turbopack production build, and to run, in a real browser (2026-09-20). An
 * aliased (`@/…`) import was not tested. A worker whose import fails does so
 * SILENTLY (uploads fall back to the main thread), so re-check the built worker
 * chunk whenever this import changes.
 */

import {
  IMAGE_VARIANTS,
  VARIANT_MIME,
  fitWithin,
  variantFileName,
  variantMimeFor,
} from './image-variants.config';

/**
 * Can this engine encode WebP from a canvas? A 1 x 1 probe, because the only
 * way to know is to ask: WebKit answers a WebP request with a PNG instead of
 * failing. A probe that cannot run at all changes nothing (WebP is assumed).
 */
async function canEncodeWebp(): Promise<boolean> {
  try {
    const probe = new OffscreenCanvas(1, 1);
    if (!probe.getContext('2d')) return true;
    const blob = await probe.convertToBlob({ type: VARIANT_MIME });
    return blob.type === VARIANT_MIME;
  } catch {
    return true;
  }
}

async function bitmapToBlob(
  bitmap: ImageBitmap,
  maxDim: number,
  quality: number,
  mime: string,
): Promise<Blob | null> {
  const { w, h } = fitWithin(bitmap.width, bitmap.height, maxDim);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  try {
    return await canvas.convertToBlob({ type: mime, quality });
  } catch {
    return null;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  const buf = await blob.arrayBuffer();
  // FileReader is available in workers; use a manual base64 encode
  // anyway since it's straightforward and avoids the FileReader
  // event-driven dance.
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  // `btoa` exists in worker scope on every supported browser.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b64 = (self as any).btoa(binary) as string;
  return `data:${blob.type};base64,${b64}`;
}

self.onmessage = async (e: MessageEvent<{ file: File }>) => {
  const file = e.data?.file;
  if (!file) {
    self.postMessage({ ok: false, message: 'missing-file' });
    return;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    self.postMessage({
      ok: false,
      message: err instanceof Error ? err.message : 'decode-failed',
    });
    return;
  }
  try {
    const { master: masterSpec, thumb: thumbSpec, lqip: lqipSpec } = IMAGE_VARIANTS;
    const mime = variantMimeFor(file.type, await canEncodeWebp());
    const masterBlob = await bitmapToBlob(
      bitmap,
      masterSpec.maxDimension,
      masterSpec.quality,
      mime,
    );
    let master: File;
    if (masterBlob && masterBlob.size < file.size) {
      // Named and typed after what the encoder RETURNED, not what it was asked for.
      master = new File([masterBlob], variantFileName(file.name, masterBlob.type), {
        type: masterBlob.type || VARIANT_MIME,
        lastModified: file.lastModified,
      });
    } else {
      master = file;
    }
    const thumbBlob = await bitmapToBlob(bitmap, thumbSpec.maxDimension, thumbSpec.quality, mime);
    const lqipBlob = await bitmapToBlob(bitmap, lqipSpec.maxDimension, lqipSpec.quality, mime);
    const lqip = lqipBlob ? await blobToDataUrl(lqipBlob) : null;
    self.postMessage({
      ok: true,
      master,
      thumbBlob,
      lqip: lqip && lqip.length <= lqipSpec.maxChars ? lqip : null,
    });
  } catch (err) {
    self.postMessage({
      ok: false,
      message: err instanceof Error ? err.message : 'compress-failed',
    });
  } finally {
    bitmap.close();
  }
};
