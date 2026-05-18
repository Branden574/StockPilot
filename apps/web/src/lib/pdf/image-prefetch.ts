import 'server-only';

import { unstable_cache } from 'next/cache';

const PER_IMAGE_TIMEOUT_MS = 8_000;
const DATA_URI_CACHE_TTL_SEC = 25 * 24 * 60 * 60; // 25 days

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
const getCachedImageDataUri = unstable_cache(
  async (url: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get('content-type') ?? 'image/webp';
      const b64 = Buffer.from(buf).toString('base64');
      return `data:${contentType};base64,${b64}`;
    } catch {
      // Timeout / network blip / aborted — treat as no image.
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
  // v2 (2026-05-18): bumped after Supabase image-transformation quota
  // cap (107/100) earlier in the cycle returned 429s that this cache
  // dutifully stored as `null` for 25 days. New version = fresh cache,
  // poisoned entries no longer reachable.
  ['pdf-image-data-uri-v2'],
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
export async function prefetchImagesAsDataUris<K>(
  entries: Iterable<readonly [K, string]>,
): Promise<Map<K, string | null>> {
  const out = new Map<K, string | null>();
  const list = Array.from(entries);
  if (list.length === 0) return out;

  await Promise.all(
    list.map(async ([key, url]) => {
      const dataUri = await getCachedImageDataUri(url);
      out.set(key, dataUri);
    }),
  );
  return out;
}
