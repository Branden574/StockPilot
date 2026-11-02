import 'server-only';

import { unstable_cache } from 'next/cache';

import {
  hasPngSignature,
  jpegPassesUnchanged,
  pngFitInside,
  pngPassesUnchanged,
  withCappedImage,
  type ImageKind,
} from '@/lib/image-decode';
import { fetchItemImage, itemImageFetchRoute } from '@/lib/item-image-fetch';

/** How long one image or logo fetch may take before it is aborted. */
export const PDF_IMAGE_TIMEOUT_MS = 8_000;
const DATA_URI_CACHE_TTL_SEC = 25 * 24 * 60 * 60; // 25 days
/** Largest image this helper will read. Checked on Content-Length first,
 *  then on the bytes actually streamed, so a host that omits or lies about
 *  the length cannot make a function buffer an unbounded body. */
export const PDF_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** The longest edge, in pixels, of a photo printed with no size of its own
 *  (slips, report PDFs, the inventory snapshot): photo cells are 22 to 38 pt,
 *  and the stored 200 px thumbnails pass as they are. */
export const PDF_PHOTO_MAX_EDGE_PX = 400;
/** The longest edge of a logo re-made for a branded header (drawn at 36 pt). */
export const PDF_LOGO_MAX_EDGE_PX = 512;
/** A PNG or JPEG logo up to this edge may print as it is. */
const PDF_LOGO_UNCHANGED_MAX_EDGE_PX = 1024;
/** The most bytes a PNG or JPEG may have to reach react-pdf as it is. */
const PDF_UNCHANGED_MAX_BYTES = 1024 * 1024;

/** Every JPEG this file makes: a fit-inside resize, then any transparency
 *  flattened onto white, then JPEG. libvips paints a transparent pixel black
 *  on a JPEG save (B62), so no JPEG may skip the flatten. The decode is the
 *  capped decoder's (lib/image-decode.ts): only `kinds` are read, within
 *  their pixel caps, with the EXIF orientation applied. */
const PDF_JPEG_BACKGROUND = '#ffffff';
async function jpegOnWhite(
  rawBytes: Buffer,
  kinds: readonly ImageKind[],
  opts: { quality: number; maxEdgePx: number },
): Promise<Buffer> {
  return withCappedImage(rawBytes, kinds, (img) =>
    img
      .resize({
        width: opts.maxEdgePx,
        height: opts.maxEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: PDF_JPEG_BACKGROUND })
      .jpeg({ quality: opts.quality, mozjpeg: true })
      .toBuffer(),
  );
}

/**
 * @react-pdf/image@3.x supports JPEG, PNG, and SVG ONLY — no WebP, no
 * AVIF, no GIF. The codebase stores item thumbnails as WebP (see
 * migration 0122), so for the PDF path we transcode unsupported
 * formats to JPEG on white using `sharp` (already in the dep graph via
 * Next): a see-through background prints white, never black.
 *
 * What reaches react-pdf (S45), at most PDF_PHOTO_MAX_EDGE_PX on its longest
 * edge, never enlarged:
 *   1. a PNG that pngPassesUnchanged allows (its structure checked, within
 *      400 px and 1 MiB), unchanged: react-pdf keeps its transparency;
 *   2. any other PNG, re-made as a PNG by the capped decoder, its
 *      transparency kept;
 *   3. a JPEG that jpegPassesUnchanged allows (no EXIF or XMP, every
 *      segment read as react-pdf reads it and few enough to parse quickly,
 *      within 400 px and 1 MiB), unchanged;
 *   4. anything else the decoder reads (JPEG, WebP, AVIF, GIF), re-made as a
 *      JPEG on white with its EXIF orientation applied.
 * Other bytes (SVG, TIFF, HEIC, damaged files) and sizes over the decoder's
 * caps are refused before sharp is called. Content-type headers from
 * Supabase transformed URLs can lie, so the bytes decide.
 *
 * Bytes-in/bytes-out, no IO. Failure returns null so the consumer
 * falls back to a placeholder instead of crashing the document.
 */
async function ensurePdfCompatibleBytes(
  rawBytes: Buffer,
  declaredContentType: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const unchanged = { maxEdgePx: PDF_PHOTO_MAX_EDGE_PX, maxBytes: PDF_UNCHANGED_MAX_BYTES };
  try {
    if (await pngPassesUnchanged(rawBytes, unchanged)) {
      return { bytes: rawBytes, contentType: 'image/png' };
    }
    // The decoder reads the header (for an AVIF, a walk of its boxes) once,
    // in withCappedImage; here the signature is enough to choose the chain.
    if (hasPngSignature(rawBytes)) {
      const png = await pngFitInside(rawBytes, ['png'], PDF_PHOTO_MAX_EDGE_PX);
      return { bytes: png, contentType: 'image/png' };
    }
    if (jpegPassesUnchanged(rawBytes, unchanged)) {
      return { bytes: rawBytes, contentType: 'image/jpeg' };
    }
    const jpegBytes = await jpegOnWhite(rawBytes, ['jpeg', 'webp', 'avif', 'gif'], {
      quality: 80,
      maxEdgePx: PDF_PHOTO_MAX_EDGE_PX,
    });
    return { bytes: jpegBytes, contentType: 'image/jpeg' };
  } catch (err) {
    // A refusal or a sharp failure: log why, so a blank image in a PDF is
    // diagnosable instead of silent. Caller treats null as "no image".
    console.warn(
      `[pdf-image] transcode failed (declaredContentType=${declaredContentType}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Downscale for a small PDF cell (the Book Order Totals covers): the longest
 * edge at most `maxEdgePx`, never enlarged, aspect kept (fit inside, so a
 * portrait cover is never cropped), transparency flattened to white, JPEG
 * q75 (jpegOnWhite, the same operations in the same order as before B62, so
 * the bytes and the v6 cache entries are unchanged). A 2048px master becomes
 * a few KB instead of ~40-70 KB per row. Every format goes through the capped
 * decoder (S45), so what is stored is always sharp's own JPEG.
 */
async function downscaleForPdf(rawBytes: Buffer, maxEdgePx: number): Promise<Buffer | null> {
  try {
    return await jpegOnWhite(rawBytes, ['png', 'jpeg', 'webp', 'avif', 'gif'], {
      quality: 75,
      maxEdgePx,
    });
  } catch (err) {
    console.warn(
      `[pdf-image] downscale failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Where a URL may be fetched from, or null when it may not be fetched. One
 *  implementation with the inventory export's fetcher: lib/item-image-fetch.ts. */
export const pdfImageFetchRoute = itemImageFetchRoute;

/**
 * What a log line may say about a URL. A storage URL keeps its first 80
 * characters (the path, never reaching the ?token= of a signed URL); any
 * other URL is reduced to its host.
 */
export function pdfImageLogLabel(url: string): string {
  const route = pdfImageFetchRoute(url);
  if (route === 'storage') return url.split('?')[0]!.slice(0, 80);
  try {
    return `host ${new URL(url).hostname}`;
  } catch {
    return 'unparseable url';
  }
}

async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new Error('pdf-image over the byte cap');
  }
  const body = res.body;
  if (!body) return Buffer.from(await res.arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('pdf-image over the byte cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

/**
 * One image's bytes as a data URI, or a throw (see the note on the cached
 * functions). A Storage read on the project origin is fetched with plain fetch,
 * which never follows a redirect. Any other URL goes through the SSRF-hardened
 * safeFetch with the book-cover host allowlist (pinned IP, every redirect hop
 * re-validated): the legacy custom_fields.thumbnail_url this helper is fed is
 * checked only for type and length where it is stored and is writable by
 * staff, so a bare fetch() of it could reach internal hosts. A host off the
 * allowlist throws, and the row gets its placeholder. The routing lives in
 * lib/item-image-fetch.ts, shared with the export.
 */
async function fetchImageAsDataUri(url: string, maxEdgePx: number | null): Promise<string> {
  const { body: rawBuf, contentType } = await fetchImageBody(url);
  if (maxEdgePx !== null) {
    const small = await downscaleForPdf(rawBuf, maxEdgePx);
    if (!small) throw new Error('pdf-image undecodable bytes');
    return `data:image/jpeg;base64,${small.toString('base64')}`;
  }
  const declaredCt = contentType ?? 'image/webp';
  const compat = await ensurePdfCompatibleBytes(rawBuf, declaredCt);
  if (!compat) throw new Error('pdf-image undecodable bytes');
  const b64 = compat.bytes.toString('base64');
  return `data:${compat.contentType};base64,${b64}`;
}

/** One image URL's body (under the byte cap) and declared type, fetched by its
 *  route within PDF_IMAGE_TIMEOUT_MS. Throws on any failure. */
async function fetchImageBody(url: string): Promise<{ body: Buffer; contentType: string | null }> {
  const route = pdfImageFetchRoute(url);
  if (!route) throw new Error('pdf-image url not fetchable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PDF_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetchItemImage(url, controller.signal);
    if (!res.ok) throw new Error(`pdf-image fetch ${res.status}`);
    const body = await readCappedBody(res, PDF_IMAGE_MAX_BYTES);
    return { body, contentType: res.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A logo's bytes as a data: URI. A PNG or JPEG within 1024 px and 1 MiB that
 * pngPassesUnchanged or jpegPassesUnchanged allows is returned unchanged, so
 * it prints exactly as it did. Any other PNG, JPEG, WebP or AVIF logo is
 * re-made by the capped decoder as a PNG at most PDF_LOGO_MAX_EDGE_PX on its
 * longest edge, never enlarged, its transparency kept and its EXIF
 * orientation applied. Throws for anything else (SVG, GIF, HEIC, damaged
 * files, AVIF over 4096 x 4096 and other formats over 50 million pixels) and
 * on any fetch failure (see prefetchPdfLogo).
 */
async function fetchLogoAsDataUri(url: string): Promise<string> {
  const { body } = await fetchImageBody(url);
  const unchanged = {
    maxEdgePx: PDF_LOGO_UNCHANGED_MAX_EDGE_PX,
    maxBytes: PDF_UNCHANGED_MAX_BYTES,
  };
  if (await pngPassesUnchanged(body, unchanged)) {
    return `data:image/png;base64,${body.toString('base64')}`;
  }
  if (jpegPassesUnchanged(body, unchanged)) {
    return `data:image/jpeg;base64,${body.toString('base64')}`;
  }
  const png = await pngFitInside(body, ['png', 'jpeg', 'webp', 'avif'], PDF_LOGO_MAX_EDGE_PX);
  return `data:image/png;base64,${png.toString('base64')}`;
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
  async (url: string): Promise<string> => fetchImageAsDataUri(url, null),
  // v5 (2026-06-02): bumped to evict 25-day-poisoned null entries from earlier
  // transient failures (the cause of "a lot of item images missing in PDFs"),
  // AND the fn now throws-instead-of-caching-null so this stops recurring.
  // v7 (B62): data URIs stored before the flatten printed a see-through photo
  // on a black square; v6 is the sized key.
  // v8 (S45): v7 entries hold PNG and JPEG bytes exactly as they were
  // fetched, before the structure checks and the 400 px limit, and would be
  // served for up to 25 days.
  ['pdf-image-data-uri-v8'],
  { revalidate: DATA_URI_CACHE_TTL_SEC, tags: ['pdf-image-data-uri'] },
);

/** The downscaled variant. Its own key (v6) and the size as an argument, so
 *  a sized entry and an unsized one for the same URL never collide. Its
 *  entries were always sharp's own JPEG, so the key stays. */
const getCachedSizedImageDataUri = unstable_cache(
  async (url: string, maxEdgePx: number): Promise<string> => fetchImageAsDataUri(url, maxEdgePx),
  ['pdf-image-data-uri-v6'],
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
 * Failures (per-image timeout, 404, network blip, a host off the cover
 * allowlist, a body over the byte cap) are returned as `null` so the
 * consumer can render a placeholder instead of erroring the whole document.
 *
 * Caller passes `[key, signedUrl]` pairs; the key round-trips so the
 * consumer can map the result back to its row / item / whatever.
 * `opts.maxEdgePx` downscales every image (see downscaleForPdf); callers
 * that pass nothing get each image at its own size up to
 * PDF_PHOTO_MAX_EDGE_PX (ensurePdfCompatibleBytes).
 */
// Bound concurrent image fetches. A long report (now up to 1000 photos) must
// not fire 1000 simultaneous storage requests on a cold render — that floods
// the connection pool / risks 429s and the 8s-per-image timeout, blanking the
// tail. A small worker pool keeps memory + connections sane while still finishing
// a 1000-image cold render well under the 60s function budget (warm = cached).
const PREFETCH_CONCURRENCY = 24;

export async function prefetchImagesAsDataUris<K>(
  entries: Iterable<readonly [K, string]>,
  opts: { maxEdgePx?: number } = {},
): Promise<Map<K, string | null>> {
  const out = new Map<K, string | null>();
  const list = Array.from(entries);
  if (list.length === 0) return out;
  const maxEdgePx =
    typeof opts.maxEdgePx === 'number' && Number.isFinite(opts.maxEdgePx) && opts.maxEdgePx > 0
      ? Math.round(opts.maxEdgePx)
      : null;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < list.length) {
      const entry = list[cursor++];
      if (!entry) break;
      const [key, url] = entry;
      // The cached fns throw on failure (so failures aren't negatively
      // cached). Swallow here → null → consumer renders a placeholder, and the
      // NEXT render retries the fetch instead of serving a stuck null.
      try {
        out.set(
          key,
          maxEdgePx === null
            ? await getCachedImageDataUri(url)
            : await getCachedSizedImageDataUri(url, maxEdgePx),
        );
      } catch (err) {
        console.warn(
          `[pdf-image] prefetch failed for ${pdfImageLogLabel(url)}: ${err instanceof Error ? err.message : String(err)}`,
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

// Throws on failure like the image caches above, so a failure is never stored.
// Keyed by the URL, and a new upload is a new URL (org-logo-uploader.tsx puts a
// timestamp in the path), so a changed logo is fetched afresh.
// v2 (S45): v1 entries hold PNG and JPEG logos exactly as they were fetched,
// before the structure checks, and would be served for up to 25 days.
const getCachedLogoDataUri = unstable_cache(
  async (url: string): Promise<string> => fetchLogoAsDataUri(url),
  ['pdf-logo-data-uri-v2'],
  { revalidate: DATA_URI_CACHE_TTL_SEC, tags: ['pdf-image-data-uri'] },
);

/**
 * An organization's logo for a branded PDF header, as a data: URI react-pdf
 * draws with no I/O, or null for no logo.
 *
 * organizations.logo_url is set by an owner or admin. The settings action
 * (setOrgLogoUrlAction) holds it to the org's own file in the logo bucket, but
 * the database does not, so a direct update can store any string. Handed to
 * react-pdf, <Image src> fetched such a value with the global fetch (following
 * redirects) or, for a string that is not an absolute URL, read it as a file
 * on the server. Here it is fetched like an item image
 * (lib/item-image-fetch.ts): a Storage read on the project origin by plain
 * fetch that never follows a redirect, any other http(s) URL only from the
 * cover hosts through the SSRF guard, anything else refused before a request.
 * It gets PDF_IMAGE_TIMEOUT_MS and the PDF_IMAGE_MAX_BYTES cap. BrandedHeader
 * draws nothing but such a data: URI.
 *
 * A PNG or JPEG logo within 1024 px and 1 MiB whose structure checks pass is
 * returned unchanged, so it prints exactly as it did. Any other PNG, JPEG,
 * WebP or AVIF logo is re-made by the capped decoder (lib/image-decode.ts) as
 * a PNG at most 512 px, its transparency kept: react-pdf could not read WebP
 * or AVIF, so those never printed before (S45). An AVIF over 4096 x 4096, any
 * other logo over 50 million pixels, a GIF and a damaged file print no logo.
 * react-pdf did read SVG: an SVG logo, which the uploader accepted only from
 * 2026-05-05 to 2026-05-09, printed before and prints no logo now, on purpose
 * (SVG was dropped as a logo format for carrying script, and this keeps
 * react-pdf's and libvips' SVG parsers off stored bytes). Any failure is no
 * logo, never a failed document, and the next document tries again. With no
 * logo the header starts the organization name at the left edge; before, a
 * logo react-pdf could not draw still left an empty 36 pt square there.
 */
export async function prefetchPdfLogo(logoUrl: string | null | undefined): Promise<string | null> {
  const url = logoUrl?.trim();
  if (!url) return null;
  try {
    return await getCachedLogoDataUri(url);
  } catch (err) {
    console.warn(
      `[pdf-image] logo prefetch failed for ${pdfImageLogLabel(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
