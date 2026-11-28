/**
 * Range-read of a storage object's LEADING BYTES for magic-byte sniffing
 * (security wave: MED-23 follow-up).
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------
 * `sniffImage` (lib/image-signature.ts) is byte-pure and only ever needs the
 * first few kilobytes of a file, but all three of its callers used to
 * `download()` the ENTIRE object to feed it — up to the bucket's
 * file_size_limit (10 MB for maintenance-photos and item-images, 5 MB for
 * org-logos) buffered per call, for a verdict the first 4 KB decides.
 * @supabase/storage-js exposes no range option on `download()`, so the range
 * request is made by hand:
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
 *
 * EVERY STEP ANSWERS, AND IN TIME (lab walk 5). Inside the app, `fetch` is
 * Next's: a GET with options and no `signal` is deduped, which means its body
 * is teed and one branch is kept for later. Cancelling the branch we were
 * handed then settles only when the kept branch is read or cancelled too,
 * which nothing ever does, so a read that stopped early and awaited its
 * cancel waited forever (every whole read, every over-size answer). So:
 *   - every fetch here passes the signal of its own AbortController: that
 *     opts out of the dedupe (no kept copy), and the request is aborted when
 *     its step ends, however it ends;
 *   - nothing here awaits a cancel or an abort: a body we stop reading is
 *     cancelled without waiting, with any error dropped;
 *   - every storage step (the object's size, the signed URL, the window, the
 *     whole read) has a hard time limit, and a step past it answers
 *     STORAGE_READ_TIMED_OUT, which the callers answer as "could not be
 *     checked" (refused). storage-js takes no signal for the size and the
 *     signed URL, so those two are raced against their limit and a late answer
 *     is dropped. Inside a finalize check, each step also gets no more than
 *     the time the check has left of its one deadline (lib/storage-steps.ts,
 *     review round 3).
 * The object's SIZE is asked first (storage's own record of it): an empty
 * object is answered from it at once, one over the caller's ceiling is
 * answered without reading any of its body, and the window asks for no more
 * bytes than the object has (the lab's storage never answers a range that
 * runs past the end of a small object). When storage gives no size, the
 * window read learns it from its headers, as before.
 */

import { sniffNeedsMoreBytes } from './image-signature';
import {
  isStorageReadTimedOut,
  settleInTime,
  STORAGE_STEP_LIMIT_MS,
  type StorageReadTimedOut,
} from './storage-steps';

export {
  isStorageReadTimedOut,
  STORAGE_READ_TIMED_OUT,
  STORAGE_STEP_LIMIT_MS,
  type StorageReadTimedOut,
} from './storage-steps';

export const SNIFF_PREFIX_BYTES = 4096;

/** The lifetime of the signed URL minted for the range read. It is consumed
 *  immediately by this process (once, or twice back-to-back when the
 *  indeterminate-window fallback fires) — 60s is generous headroom, not a
 *  grant. */
const PREFIX_URL_TTL_SECONDS = 60;

/**
 * The hard time limits (lab walk 5). A small step (the size, the signed URL,
 * the leading window: STORAGE_STEP_LIMIT_MS, 8 s) answers in milliseconds
 * from a healthy storage; the whole read is at most a bucket's cap (15 MB).
 * Past its limit a step is STORAGE_READ_TIMED_OUT.
 */
export const STORAGE_WHOLE_READ_LIMIT_MS = 20_000;

/**
 * Runs one storage step under a hard time limit (lib/storage-steps.ts: no
 * more than its finalize check has left). The step is handed the signal of
 * its own AbortController, which every fetch in it passes; the controller is
 * aborted when the step ends, answered or not, and nothing waits for that. A
 * step that throws is null, like every failure here.
 */
async function withinLimit<T>(
  ms: number,
  step: (signal: AbortSignal) => Promise<T>,
): Promise<T | null | StorageReadTimedOut> {
  const outcome = await settleInTime(ms, step);
  if (isStorageReadTimedOut(outcome)) return outcome;
  return outcome.answered ? outcome.value : null;
}

/** Stops reading a body without waiting: a teed body's cancel may never settle. */
function dropBody(res: Response): void {
  if (!res.body) return;
  void res.body.cancel().catch(() => undefined);
}

export type ObjectPrefix = {
  /** The first min(SNIFF_PREFIX_BYTES, totalSize) bytes of the object —
   *  or the WHOLE object, when the window alone was indeterminate for the
   *  sniff (the metadata-heavy-JPEG fallback in the header comment). Either
   *  way: always a leading, contiguous run the sniffer can judge. */
  prefix: Uint8Array;
  /** The object's FULL size in bytes — never the prefix length. */
  totalSize: number;
  /**
   * Set when the caller gave a ceiling (`maxTotalBytes`) and the size storage
   * stated is above it: the body was never read (`prefix` is empty) and the
   * caller refuses the object as too large (part 6).
   */
  overLimit?: true;
};

/** A ceiling for one read (part 6): a size storage states above it is refused before any body read. */
export interface ObjectReadLimit {
  maxTotalBytes?: number;
}

/** The answer for an object over the ceiling: its size, and nothing of its body. */
function overLimitAnswer(total: number): ObjectPrefix {
  return { prefix: new Uint8Array(0), totalSize: total, overLimit: true };
}

/** The storage-js methods this helper needs, stated structurally so tests
 *  and callers are not coupled to the concrete StorageFileApi class. */
export type PrefixCapableBucket = {
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  }>;
  /** The object's record: its size (lab walk 5, F1). */
  info(path: string): Promise<{
    data: { size?: number | null } | null;
    error: { message: string } | null;
  }>;
};

/**
 * The size storage recorded for the object, under the step limit. Null when
 * storage gave none (an error, a missing object, an older storage): the
 * window read then learns the size from its own headers, as before.
 */
async function recordedSize(bucket: PrefixCapableBucket, path: string): Promise<number | null | StorageReadTimedOut> {
  return withinLimit(STORAGE_STEP_LIMIT_MS, async () => {
    const { data, error } = await bucket.info(path);
    const size = error ? null : data?.size;
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
  });
}

/** A signed URL for the object, under the step limit. Null when storage refuses (a missing object). */
async function signedUrlFor(bucket: PrefixCapableBucket, path: string): Promise<string | null | StorageReadTimedOut> {
  return withinLimit(STORAGE_STEP_LIMIT_MS, async () => {
    const { data, error } = await bucket.createSignedUrl(path, PREFIX_URL_TTL_SECONDS);
    return error || !data?.signedUrl ? null : data.signedUrl;
  });
}

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
    // (After a clean `done` this is a no-op.) Never awaited: on a teed body it
    // may never settle (lab walk 5); the step's abort ends the request.
    void reader.cancel().catch(() => undefined);
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
 * The object's size first, then its leading window (lab walk 5): an empty
 * object is answered from its size alone, and one over the ceiling without
 * any of its body read. Each step under its time limit.
 */
async function leadingWindowOf(
  bucket: PrefixCapableBucket,
  path: string,
  fetchImpl: typeof fetch,
  limit: ObjectReadLimit,
): Promise<{ head: ObjectPrefix; signedUrl: string | null } | null | StorageReadTimedOut> {
  const size = await recordedSize(bucket, path);
  if (isStorageReadTimedOut(size)) return size;
  if (size === 0) return { head: { prefix: new Uint8Array(0), totalSize: 0 }, signedUrl: null };
  if (size !== null && limit.maxTotalBytes !== undefined && size > limit.maxTotalBytes) {
    return { head: overLimitAnswer(size), signedUrl: null };
  }
  const signedUrl = await signedUrlFor(bucket, path);
  if (signedUrl === null || isStorageReadTimedOut(signedUrl)) return signedUrl;
  const head = await withinLimit(STORAGE_STEP_LIMIT_MS, (signal) =>
    fetchLeadingWindow(signedUrl, fetchImpl, limit, size, signal),
  );
  if (head === null || isStorageReadTimedOut(head)) return head;
  return { head, signedUrl };
}

/**
 * Fetches the object's leading SNIFF_PREFIX_BYTES and its full size — widened
 * to the whole object when the window alone cannot decide the sniff (see the
 * header comment). Null on ANY failure (missing object, sign refusal, bad
 * status, undeterminable size) — callers fail closed on null exactly as they
 * did on a failed `download()`. A step past its time limit is
 * STORAGE_READ_TIMED_OUT.
 */
export async function fetchObjectPrefix(
  bucket: PrefixCapableBucket,
  path: string,
  fetchImpl: typeof fetch = fetch,
  limit: ObjectReadLimit = {},
): Promise<ObjectPrefix | null | StorageReadTimedOut> {
  const window = await leadingWindowOf(bucket, path, fetchImpl, limit);
  if (window === null || isStorageReadTimedOut(window)) return window;
  const { head, signedUrl } = window;
  if (head.overLimit || signedUrl === null) return head;

  // The metadata-heavy-JPEG fallback: only when the sniff of the window is
  // INDETERMINATE (classifier ran out of bytes — never for a definitive
  // fake, which stays a cheap 4 KB read) and the object actually holds bytes
  // the window did not. This re-fetch is what the OLD code did on every
  // call; here it is the exception, not the rule.
  if (head.totalSize > head.prefix.byteLength && sniffNeedsMoreBytes(head.prefix)) {
    return withinLimit(STORAGE_WHOLE_READ_LIMIT_MS, (signal) =>
      fetchWholeObject(signedUrl, head.totalSize, fetchImpl, signal),
    );
  }
  return head;
}

/**
 * The leading window ONLY, never widened (part 6): for a file whose verdict
 * is its signature and whose size is far beyond any read we would buffer, a
 * procedure video of up to a gigabyte. `fetchObjectPrefix` widens to the
 * whole object when an image sniff of the window cannot decide, and an MP4's
 * leading box is exactly the shape that can ask for that. Null on any
 * failure, like fetchObjectPrefix; STORAGE_READ_TIMED_OUT past a time limit.
 */
export async function fetchObjectWindow(
  bucket: PrefixCapableBucket,
  path: string,
  fetchImpl: typeof fetch = fetch,
  limit: ObjectReadLimit = {},
): Promise<ObjectPrefix | null | StorageReadTimedOut> {
  const window = await leadingWindowOf(bucket, path, fetchImpl, limit);
  if (window === null || isStorageReadTimedOut(window)) return window;
  return window.head;
}

/**
 * The WHOLE object, bounded (part 6): exactly `expectedSize` bytes, the size a
 * window read of the same object stated (which the caller has already held to
 * its ceiling), read from a stream that is cancelled at that size, so a
 * misbehaving or replaced object can never make this buffer more. A body that
 * ends short, or a failure anywhere, is null: the caller answers "could not be
 * read" and judges nothing. Past a time limit: STORAGE_READ_TIMED_OUT.
 */
export async function fetchObjectWhole(
  bucket: PrefixCapableBucket,
  path: string,
  expectedSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null | StorageReadTimedOut> {
  const signedUrl = await signedUrlFor(bucket, path);
  if (signedUrl === null || isStorageReadTimedOut(signedUrl)) return signedUrl;
  const whole = await withinLimit(STORAGE_WHOLE_READ_LIMIT_MS, (signal) =>
    fetchWholeObject(signedUrl, expectedSize, fetchImpl, signal),
  );
  if (whole === null || isStorageReadTimedOut(whole)) return whole;
  return whole.prefix.byteLength === expectedSize ? whole.prefix : null;
}

/** The Range request for the leading window, and the full size from the
 *  response's own headers. Null on any failure. With a ceiling, a stated
 *  size above it is answered from the headers alone: the body is dropped
 *  unread. With the size storage recorded (`knownSize`, never 0 here), the
 *  range asks for no byte past the object's end, and a response naming any
 *  other size is not this object (it changed): null. */
async function fetchLeadingWindow(
  signedUrl: string,
  fetchImpl: typeof fetch,
  limit: ObjectReadLimit,
  knownSize: number | null,
  signal: AbortSignal,
): Promise<ObjectPrefix | null> {
  const over = (total: number) => limit.maxTotalBytes !== undefined && total > limit.maxTotalBytes;
  const last = knownSize === null ? SNIFF_PREFIX_BYTES - 1 : Math.min(SNIFF_PREFIX_BYTES, knownSize) - 1;
  const changed = (total: number) => knownSize !== null && total !== knownSize;
  let res: Response;
  try {
    res = await fetchImpl(signedUrl, {
      headers: { range: `bytes=0-${last}` },
      cache: 'no-store',
      signal,
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
    dropBody(res);
    const total = totalFromContentRange(res.headers.get('content-range'));
    if (total !== 0 || changed(total)) return null;
    return { prefix: new Uint8Array(0), totalSize: 0 };
  }

  if (res.status === 206) {
    const total = totalFromContentRange(res.headers.get('content-range'));
    if (total === null || changed(total)) {
      dropBody(res);
      return null;
    }
    if (over(total)) {
      dropBody(res);
      return overLimitAnswer(total);
    }
    // The body is the (at most SNIFF_PREFIX_BYTES-long) range itself. A body
    // read that fails (the connection drops mid-body) is null like every
    // other failure here, never a throw out of this function (L65a).
    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
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
    const total = lenHeader === null ? NaN : Number(lenHeader);
    if (!Number.isSafeInteger(total) || total < 0 || changed(total)) {
      dropBody(res);
      return null;
    }
    if (over(total)) {
      dropBody(res);
      return overLimitAnswer(total);
    }
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

  dropBody(res);
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
 * the size storage attested to, which the caller's bucket caps (15 MB for
 * po-attachments and order-attachments, 10 MB for maintenance-photos and
 * item-images, 5 MB for org-logos): no more than a whole download() buffers,
 * and only in this rare case rather than on every call. Null on any failure:
 * fail closed as unreadable — the callers' no-delete path — rather than risk
 * condemning a legitimate file on a partial second read.
 */
async function fetchWholeObject(
  signedUrl: string,
  expectedSize: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ObjectPrefix | null> {
  let res: Response;
  try {
    res = await fetchImpl(signedUrl, { cache: 'no-store', signal });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    dropBody(res);
    return null;
  }
  // A stated length other than the one the window read named means the
  // object changed between the two reads: unreadable, judged on nothing.
  const lenHeader = res.headers.get('content-length');
  if (lenHeader !== null && Number(lenHeader) !== expectedSize) {
    dropBody(res);
    return null;
  }
  if (!res.body) return null;
  try {
    // With no stated length, the body must END BY ITSELF at the attested
    // size: one byte more is read for that, and a body with more is not the
    // object the window read (it changed): unreadable, never a prefix judged
    // as the whole.
    const stated = lenHeader !== null;
    const body = await readPrefixFromStream(res.body, stated ? expectedSize : expectedSize + 1);
    // A stream that ended short of the attested size is a failed read, not a
    // smaller object — judging (and possibly deleting) on a partial body is
    // exactly what this fallback exists to avoid.
    if (body.byteLength !== expectedSize) return null;
    return { prefix: body, totalSize: expectedSize };
  } catch {
    return null;
  }
}
