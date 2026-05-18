import 'server-only';

const PER_IMAGE_TIMEOUT_MS = 3_000;

/**
 * Fetches a batch of image URLs in PARALLEL and returns each as a
 * base64 `data:` URI string. react-pdf's `<Image src>` accepts either
 * a URL (which it fetches synchronously at render time) or a data
 * URI (which it embeds directly with no I/O). Pre-resolving to data
 * URIs flips render-time image fetching from sequential per-image
 * HTTP to a single parallel pre-flight, cutting large-photo PDFs
 * from ~10s to ~1-2s.
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_IMAGE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          out.set(key, null);
          return;
        }
        const buf = await res.arrayBuffer();
        const contentType = res.headers.get('content-type') ?? 'image/webp';
        const b64 = Buffer.from(buf).toString('base64');
        out.set(key, `data:${contentType};base64,${b64}`);
      } catch {
        // Timeout, network error, or aborted — treat as missing image.
        // The PDF still renders; the row gets a placeholder square.
        out.set(key, null);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return out;
}
