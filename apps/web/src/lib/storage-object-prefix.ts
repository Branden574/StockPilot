/**
 * Range-read of a storage object's LEADING BYTES for magic-byte sniffing
 * (security wave: MED-23 follow-up).
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------
 * `sniffImage` (lib/image-signature.ts) is byte-pure and only ever needs the
 * first few kilobytes of a file, but all three of its callers used to
 * `download()` the ENTIRE object to feed it — up to the bucket's
 * file_size_limit (15 MB for maintenance-photos) buffered per finalize call,
 * for a verdict the first 4 KB decides. @supabase/storage-js exposes no range
 * option on `download()`, so the range request is made by hand:
 *
 *   1. mint a short-lived signed URL for the object (through the SAME storage
 *      client the caller was downloading with, so an RLS-scoped client keeps
 *      its RLS-scoped read and an admin client keeps its bypass);
 *   2. fetch it with `Range: bytes=0-4095`;
 *   3. if the server honors the range (206), the body IS the prefix and the
 *      `Content-Range` trailer names the FULL size;
 *   4. if the server ignores it (200), read the stream INCREMENTALLY, keep
 *      the first 4096 bytes, and cancel the reader — the rest of the object
 *      is never buffered — taking the full size from `Content-Length`.
 *
 * ONE class of legitimate file cannot be judged inside the window: a JPEG
 * whose SOF marker sits beyond 4 KB of leading metadata. Camera originals
 * routinely carry a 5-20 KB APP1 EXIF segment (embedded thumbnail), and
 * multi-segment APP2 ICC profiles or XMP packets can push the SOF hundreds of
 * KB in — and such files genuinely reach production as item-image masters,
 * because compressImageVariants uploads the ORIGINAL untranscoded file
 * whenever its WebP re-encode is not smaller or the source will not decode
 * client-side (CMYK JPEGs, which also carry the large ICC profiles). Judging
 * those on the window alone returns "not an image", and the callers DELETE on
 * that verdict. So when the sniff of the window is INDETERMINATE — the
 * classifier ran out of bytes rather than reaching a verdict
 * (sniffNeedsMoreBytes, lib/image-signature.ts) — and the object holds more
 * bytes than the window, this helper falls back to reading the WHOLE object
 * (memory-bounded by the size storage itself declared) and returns that as
 * the prefix instead. Verdicts therefore match the old full-download behavior
 * for every file, while everything decidable in 4 KB — every well-formed PNG
 * and WebP, web-exported JPEGs, every fake — stays a 4 KB read.
 *
 * The FULL size is returned alongside the prefix because one caller
 * (maintenance-attachments.finalize) records and gates on the object's real
 * byte size; sizing the prefix would silently record 4096 for every photo.
 *
 * Every failure path returns null — fail closed. Callers already treat an
 * unreadable object as "the upload never happened" (no phantom rows), and a
 * signed-URL mint for a nonexistent object errors, so the finalize-time
 * existence check the old download provided is preserved.
 *
 * Plain `fetch`, not `safeFetch` (lib/ssrf-guard.ts): the guard exists for
 * URLs whose HOST comes from user input. This URL is minted by storage-js
 * from the server's own configured Supabase origin — the same origin
 * `download()` itself fetches without a guard — and the object path inside it
 * has been shape-validated by every caller before this function runs.
 */

import { sniffNeedsMoreBytes } from './image-signature';

export const SNIFF_PREFIX_BYTES = 4096;

/** The lifetime of the signed URL minted for the range read. It is consumed
 *  immediately by this process (once, or twice back-to-back when the
 *  indeterminate-window fallback fires) — 60s is generous headroom, not a
 *  grant. */
const PREFIX_URL_TTL_SECONDS = 60;

export type ObjectPrefix = {
  /** The first min(SNIFF_PREFIX_BYTES, totalSize) bytes of the object —
   *  or the WHOLE object, when the window alone was indeterminate for the
   *  sniff (the metadata-heavy-JPEG fallback in the header comment). Either
   *  way: always a leading, contiguous run the sniffer can judge. */
  prefix: Uint8Array;
  /** The object's FULL size in bytes — never the prefix length. */
  totalSize: number;
};

/** The one storage-js method this helper needs, stated structurally so tests
 *  and callers are not coupled to the concrete StorageFileApi class. */
export type PrefixCapableBucket = {
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  }>;
};

/** `Content-Range: bytes 0-4095/12345` → 12345. Null when the header is
 *  absent or the total is the unknown-length `*`. */
function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

/** Read at most `limit` bytes from a body stream, then cancel it so the
 *  remainder is never pulled off the wire into memory. */
async function readPrefixFromStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    // Cancel rather than drain: this is the entire point of the range read.
    // (After a clean `done` this is a no-op.)
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(received, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, limit - offset);
    out.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= limit) break;
  }
  return out;
}

/**
 * Fetches the object's leading SNIFF_PREFIX_BYTES and its full size — widened
 * to the whole object when the window alone cannot decide the sniff (see the
 * header comment). Null on ANY failure (missing object, sign refusal, bad
 * status, undeterminable size) — callers fail closed on null exactly as they
 * did on a failed `download()`.
 */
export async function fetchObjectPrefix(
  bucket: PrefixCapableBucket,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ObjectPrefix | null> {
  let signedUrl: string;
  try {
    const { data, error } = await bucket.createSignedUrl(path, PREFIX_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    signedUrl = data.signedUrl;
  } catch {
    return null;
  }

  const head = await fetchLeadingWindow(signedUrl, fetchImpl);
  if (!head) return null;

  // The metadata-heavy-JPEG fallback: only when the sniff of the window is
  // INDETERMINATE (classifier ran out of bytes — never for a definitive
  // fake, which stays a cheap 4 KB read) and the object actually holds bytes
  // the window did not. This re-fetch is what the OLD code did on every
  // call; here it is the exception, not the rule.
  if (head.totalSize > head.prefix.byteLength && sniffNeedsMoreBytes(head.prefix)) {
    return fetchWholeObject(signedUrl, head.totalSize, fetchImpl);
  }
  return head;
}

/** The Range request for the leading window, and the full size from the
 *  response's own headers. Null on any failure. */
async function fetchLeadingWindow(
  signedUrl: string,
  fetchImpl: typeof fetch,
): Promise<ObjectPrefix | null> {
  let res: Response;
  try {
    res = await fetchImpl(signedUrl, {
      headers: { range: `bytes=0-${SNIFF_PREFIX_BYTES - 1}` },
      cache: 'no-store',
    });
  } catch {
    return null;
  }

  // 416 Range Not Satisfiable is what a ZERO-BYTE object answers to any
  // `bytes=0-` range. Its `Content-Range: bytes */0` names the (zero) size, so
  // this is a readable-but-empty object, not an unreadable one: return the
  // empty prefix and let the caller's sniff refuse it — which routes it down
  // the delete-the-fake path, same as the full download used to.
  if (res.status === 416) {
    const total = totalFromContentRange(res.headers.get('content-range'));
    if (total !== 0) return null;
    await res.body?.cancel().catch(() => undefined);
    return { prefix: new Uint8Array(0), totalSize: 0 };
  }

  if (res.status === 206) {
    const total = totalFromContentRange(res.headers.get('content-range'));
    if (total === null) return null;
    // The body is the (at most SNIFF_PREFIX_BYTES-long) range itself.
    const body = new Uint8Array(await res.arrayBuffer());
    const prefix = body.byteLength > SNIFF_PREFIX_BYTES ? body.subarray(0, SNIFF_PREFIX_BYTES) : body;
    // A total SMALLER than the bytes we were just handed is self-contradictory
    // (`bytes 0-4095/5` with a 4096-byte body). Trusting it would record a
    // wrong byte_size downstream, so treat the response as unusable and fail
    // closed, same as a malformed Content-Range.
    if (total < prefix.byteLength) return null;
    return { prefix, totalSize: total };
  }

  if (res.status === 200) {
    // The server ignored the Range header: the body is the WHOLE object.
    // Content-Length is therefore the full size, and the stream is read only
    // up to the prefix and then cancelled — never buffered whole.
    //
    // The header is checked for PRESENCE before coercion: `Number(null)` is
    // 0, so a bare `Number(res.headers.get(...))` would silently report a
    // headerless response as a zero-byte object instead of failing closed.
    const lenHeader = res.headers.get('content-length');
    if (lenHeader === null) return null;
    const total = Number(lenHeader);
    if (!Number.isSafeInteger(total) || total < 0) return null;
    if (!res.body) {
      // A 200 with no body stream: only legal for an empty payload.
      return total === 0 ? { prefix: new Uint8Array(0), totalSize: 0 } : null;
    }
    try {
      const prefix = await readPrefixFromStream(res.body, SNIFF_PREFIX_BYTES);
      return { prefix, totalSize: total };
    } catch {
      return null;
    }
  }

  await res.body?.cancel().catch(() => undefined);
  return null;
}

/**
 * The fallback read: the WHOLE object, for the window-indeterminate case.
 * Re-uses the already-minted signed URL (still inside its TTL — both fetches
 * happen back-to-back in the same call).
 *
 * Memory is bounded by `expectedSize` — the full size storage's OWN response
 * headers declared on the window read — via the same read-then-cancel stream
 * walk the 200 path uses, so a misbehaving stream can never buffer more than
 * the size storage attested to (bucket caps keep that ≤ 15 MB, exactly what
 * the old always-full download() buffered on EVERY call). Null on any
 * failure: fail closed as unreadable — the callers' no-delete path — rather
 * than risk condemning a legitimate file on a partial second read.
 */
async function fetchWholeObject(
  signedUrl: string,
  expectedSize: number,
  fetchImpl: typeof fetch,
): Promise<ObjectPrefix | null> {
  let res: Response;
  try {
    res = await fetchImpl(signedUrl, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return null;
  try {
    const body = await readPrefixFromStream(res.body, expectedSize);
    // A stream that ended short of the attested size is a failed read, not a
    // smaller object — judging (and possibly deleting) on a partial body is
    // exactly what this fallback exists to avoid.
    if (body.byteLength < expectedSize) return null;
    return { prefix: body, totalSize: expectedSize };
  } catch {
    return null;
  }
}
