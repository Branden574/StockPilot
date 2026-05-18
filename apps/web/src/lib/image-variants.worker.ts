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
 */

const MAX_DIMENSION = 2048;
const THUMB_DIMENSION = 200;
const LQIP_DIMENSION = 16;
const WEBP_QUALITY = 0.85;
const THUMB_QUALITY = 0.8;
const LQIP_QUALITY = 0.5;
const LQIP_MAX_CHARS = 2000;

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
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  try {
    return await canvas.convertToBlob({ type: 'image/webp', quality });
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
    self.postMessage({
      ok: true,
      master,
      thumbBlob,
      lqip: lqip && lqip.length <= LQIP_MAX_CHARS ? lqip : null,
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
