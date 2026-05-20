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
  } catch {
    // sharp failed — log via the declaredContentType so we know which
    // format tripped it. Caller treats null as "no image".
    void declaredContentType;
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
const getCachedImageDataUri = unstable_cache(
  async (url: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const rawBuf = Buffer.from(await res.arrayBuffer());
      const declaredCt = res.headers.get('content-type') ?? 'image/webp';
      const compat = await ensurePdfCompatibleBytes(rawBuf, declaredCt);
      if (!compat) return null;
      const b64 = compat.bytes.toString('base64');
      return `data:${compat.contentType};base64,${b64}`;
    } catch {
      // Timeout / network blip / aborted — treat as no image.
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
  // v4 (2026-05-20): bumped after adding WebP→JPEG transcoding via
  // sharp. @react-pdf/image only decodes JPEG/PNG/SVG; any cache
  // entries from v3 hold raw WebP bytes that @react-pdf can't read,
  // which is why pick + packing slips were rendering empty image
  // boxes with "invalid" src strings.
  ['pdf-image-data-uri-v4'],
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
