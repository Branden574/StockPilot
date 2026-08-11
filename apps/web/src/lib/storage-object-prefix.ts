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

export const SNIFF_PREFIX_BYTES = 4096;

/** The lifetime of the signed URL minted for the range read. It is consumed
 *  once, immediately, by this process — 60s is generous headroom, not a grant. */
const PREFIX_URL_TTL_SECONDS = 60;

export type ObjectPrefix = {
  /** The first min(SNIFF_PREFIX_BYTES, totalSize) bytes of the object. */
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
 * Fetches the object's leading SNIFF_PREFIX_BYTES and its full size.
 * Null on ANY failure (missing object, sign refusal, bad status,
 * undeterminable size) — callers fail closed on null exactly as they did on a
 * failed `download()`.
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
    return {
      prefix: body.byteLength > SNIFF_PREFIX_BYTES ? body.subarray(0, SNIFF_PREFIX_BYTES) : body,
      totalSize: total,
    };
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
