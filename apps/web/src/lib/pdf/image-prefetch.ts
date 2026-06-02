import 'server-only';

import { unstable_cache } from 'next/cache';

const PER_IMAGE_TIMEOUT_MS = 8_000;
const DATA_URI_CACHE_TTL_SEC = 25 * 24 * 60 * 60; // 25 days

/**
 * @react-pdf/image@3.x supports JPEG, PNG, and SVG ONLY — no WebP, no
 * AVIF, no GIF. The codebase stores item thumbnails as WebP (see
 * migration 0122), so for the PDF path we transcode unsupported
 * formats to JPEG using `sharp` (already in the dep graph via Next).
 *
 * Bytes-in/bytes-out, no IO. Failure returns null so the consumer
 * falls back to a placeholder instead of crashing the document.
 */
async function ensurePdfCompatibleBytes(
  rawBytes: Buffer,
  declaredContentType: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  // Sniff the leading magic bytes — content-type headers from
  // Supabase transformed URLs can lie (return `image/webp` when the
  // bytes are PNG, or vice versa).
  const isPng =
    rawBytes.length > 8 &&
    rawBytes[0] === 0x89 &&
    rawBytes[1] === 0x50 &&
    rawBytes[2] === 0x4e &&
    rawBytes[3] === 0x47;
  const isJpeg =
    rawBytes.length > 2 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8;
  if (isPng) return { bytes: rawBytes, contentType: 'image/png' };
  if (isJpeg) return { bytes: rawBytes, contentType: 'image/jpeg' };

  // Anything else (WebP, AVIF, GIF, etc.) gets transcoded to JPEG.
  try {
    const { default: sharp } = await import('sharp');
    const jpegBytes = await sharp(rawBytes)
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { bytes: jpegBytes, contentType: 'image/jpeg' };
  } catch (err) {
    // sharp failed — log which format tripped it so a blank image in a PDF
    // is diagnosable instead of silent. Caller treats null as "no image".
    console.warn(
      `[pdf-image] transcode failed (declaredContentType=${declaredContentType}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Cached per-URL image fetch → base64 data URI. Same URL across
 * requests resolves to the same data URI (Vercel data cache, 25-day
 * TTL). For PDF rendering this means: first request pays the image
 * download cost; every subsequent PDF that references the same
 * signed URL (or public CDN URL) skips the fetch entirely and
 * embeds straight from cache.
 *
 * Two layers of caching compose:
 *   1. Signed URL cache (item-images service)  — same path → same
 *      URL for 25 days.
 *   2. Data URI cache (this file)              — same URL → same
 *      bytes for 25 days.
 *
 * Net effect: second + later PDF renders of the same item set are
 * dominated by react-pdf's render time (~50ms/page); image I/O is
 * effectively zero.
 *
 * The cache key includes the URL itself, so any URL change (signed
 * URL rotation past 25 days, different transform width, etc.) misses
 * the cache and re-fetches cleanly.
 */
// IMPORTANT: this cached fn THROWS on any failure instead of returning null.
// `unstable_cache` does NOT persist a rejected promise, so a transient failure
// (cold-start timeout, momentary quota blip, a 5xx) is NOT negatively cached —
// the next render retries it. Returning null here previously poisoned the entry
// for the full 25-day TTL, so a single hiccup blanked an item's image in every
// PDF until someone bumped the cache-key version (the recurring v2/v3/v4 saga).
// The caller (prefetchImagesAsDataUris) catches the throw → placeholder.
const getCachedImageDataUri = unstable_cache(
  async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`pdf-image fetch ${res.status}`);
      const rawBuf = Buffer.from(await res.arrayBuffer());
      const declaredCt = res.headers.get('content-type') ?? 'image/webp';
      const compat = await ensurePdfCompatibleBytes(rawBuf, declaredCt);
      if (!compat) throw new Error('pdf-image undecodable bytes');
      const b64 = compat.bytes.toString('base64');
      return `data:${compat.contentType};base64,${b64}`;
    } finally {
      clearTimeout(timer);
    }
  },
  // v5 (2026-06-02): bumped to evict 25-day-poisoned null entries from earlier
  // transient failures (the cause of "a lot of item images missing in PDFs"),
  // AND the fn now throws-instead-of-caching-null so this stops recurring.
  ['pdf-image-data-uri-v5'],
  { revalidate: DATA_URI_CACHE_TTL_SEC, tags: ['pdf-image-data-uri'] },
);

/**
 * Fetches a batch of image URLs in PARALLEL and returns each as a
 * base64 `data:` URI string. react-pdf's `<Image src>` accepts either
 * a URL (which it fetches synchronously at render time) or a data
 * URI (which it embeds directly with no I/O). Pre-resolving to data
 * URIs flips render-time image fetching from sequential per-image
 * HTTP to a single parallel pre-flight, cutting large-photo PDFs
 * from ~10s to ~1-2s.
 *
 * Each individual fetch goes through the Vercel data cache (25-day
 * TTL) so warm renders of the same item set skip image I/O entirely.
 *
 * Failures (per-image timeout, 404, network blip) are returned as
 * `null` so the consumer can render a placeholder instead of
 * erroring the whole document.
 *
 * Caller passes `[key, signedUrl]` pairs; the key round-trips so the
 * consumer can map the result back to its row / item / whatever.
 */
// Bound concurrent image fetches. A long report (now up to 1000 photos) must
// not fire 1000 simultaneous storage requests on a cold render — that floods
// the connection pool / risks 429s and the 8s-per-image timeout, blanking the
// tail. A small worker pool keeps memory + connections sane while still finishing
// a 1000-image cold render well under the 60s function budget (warm = cached).
const PREFETCH_CONCURRENCY = 24;

export async function prefetchImagesAsDataUris<K>(
  entries: Iterable<readonly [K, string]>,
): Promise<Map<K, string | null>> {
  const out = new Map<K, string | null>();
  const list = Array.from(entries);
  if (list.length === 0) return out;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < list.length) {
      const entry = list[cursor++];
      if (!entry) break;
      const [key, url] = entry;
      // getCachedImageDataUri throws on failure (so failures aren't negatively
      // cached). Swallow here → null → consumer renders a placeholder, and the
      // NEXT render retries the fetch instead of serving a stuck null.
      try {
        out.set(key, await getCachedImageDataUri(url));
      } catch (err) {
        console.warn(
          `[pdf-image] prefetch failed for ${url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        out.set(key, null);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, list.length) }, () => worker()),
  );
  return out;
}
