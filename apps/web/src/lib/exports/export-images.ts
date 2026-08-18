import 'server-only';

import { ItemImagesService } from '@/server/services/item-images';
import type { ServiceContext } from '@/server/services/context';

import type { InventoryExportSourceRow } from './source-row';
import { webpToPng } from './webp-to-png';

/**
 * Export image pipeline (Brief sections 18 and 24).
 *
 * URL resolution goes through ItemImagesService.primaryImagesForServerDecoding
 * — the PLAIN signed URL of the stored 200px thumb_path (a WebP), else an
 * on-the-fly Supabase transform of the master at the target width only when a
 * row has no thumb at all, else the legacy custom_fields.thumbnail_url that
 * the ISBN bulk importer writes for book covers — in ONE batched query plus
 * one batched signing call. WebP bodies are decoded HERE (sharp, see
 * webp-to-png.ts) rather than by asking Supabase's transform endpoint for a
 * PNG re-encode: on 2026-08-18 a single 272-image Excel export drew 30 HTTP
 * 429s from that endpoint and every one became a blank cell.
 *
 * NEVER use primaryMasterUrlsForItems here. That resolver returns the 2048px
 * master for the public catalog's next/image pipeline; fetching hundreds of
 * masters server-side to build one PDF is the exact landmine the public-catalog
 * work already stepped on once.
 *
 * Nothing in this module is called unless the request selected the Image field.
 */

/** Requested thumbnail width per size tier. 200 matches the stored thumb. */
export const EXPORT_IMAGE_TARGET_WIDTH_PX = {
  small: 120,
  medium: 200,
  large: 320,
} as const;

/** Per-image ceiling. A ~200px WebP is 20-50KB; 512KB is a generous outlier. */
export const MAX_EMBEDDED_IMAGE_BYTES = 512 * 1024;
/** Whole-export ceiling. Keeps one workbook inside the 60s / memory budget. */
export const MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 24 * 1024 * 1024;
/** Hard count ceiling regardless of size. */
export const MAX_EMBEDDED_IMAGES = 2_000;
export const IMAGE_FETCH_TIMEOUT_MS = 6_000;
export const IMAGE_FETCH_CONCURRENCY = 6;
/** Attempts per URL, including the first. Retried on 429/408/5xx/network/timeout. */
export const IMAGE_FETCH_MAX_ATTEMPTS = 4;
/** Backoff before attempt N+1 is BASE * 2^(N-1) plus 0-100ms of jitter. */
export const IMAGE_FETCH_BACKOFF_BASE_MS = 250;
/** Ceiling on any single wait, including one dictated by Retry-After. */
export const IMAGE_FETCH_BACKOFF_CAP_MS = 4_000;
/**
 * Whole-call ceiling. The export route's maxDuration is 60s and the row query
 * plus the workbook/PDF render need the rest; once this elapses no new fetch
 * (first attempt OR retry) starts and the remaining rows are left blank.
 */
export const IMAGE_FETCH_TOTAL_DEADLINE_MS = 35_000;

/** Brief section 24, verbatim. */
export const EXPORT_TOO_MANY_IMAGES_MESSAGE =
  'This export contains too many embedded images. Reduce the number of records, choose smaller images, or export without images.';

/**
 * Content types we will READ. SVG is excluded deliberately: it is a script
 * carrier, and neither exceljs nor react-pdf needs it. WebP is read and then
 * decoded to PNG by `decodeWebp` (sharp) because exceljs and react-pdf cannot
 * decode it themselves. `application/octet-stream` is read so a mislabelled
 * body can be classified by its magic bytes below.
 */
const READABLE_CONTENT_TYPES: ReadonlyMap<string, 'png' | 'jpeg' | 'webp' | 'unknown'> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  ['image/webp', 'webp'],
  ['application/octet-stream', 'unknown'],
]);

export interface EmbeddedImage {
  data: Uint8Array;
  extension: 'png' | 'jpeg';
}

export type ImageSkipReason =
  | 'rateLimited'
  | 'timeout'
  | 'unsupported'
  | 'oversized'
  | 'other'
  | 'deadline';

export type ImageSkipCounts = Record<ImageSkipReason, number>;

export interface FetchExportImageBytesResult {
  images: Map<string, EmbeddedImage>;
  skipped: number;
  truncated: boolean;
  /** Counts only. Never a URL, never a message. */
  skippedReasons: ImageSkipCounts;
}

export interface FetchExportImageBytesOptions {
  fetchImpl?: typeof fetch;
  /** Width the WebP decoder fits into (square box). Default 200. */
  targetWidth?: number;
  /** WebP -> PNG seam. Default: sharp via webp-to-png.ts. */
  decodeWebp?: (bytes: Uint8Array, targetWidth: number) => Promise<EmbeddedImage | null>;
  /** Clock/sleep/jitter seams for deterministic tests. Defaults are real. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Test seam only; production always uses IMAGE_FETCH_TOTAL_DEADLINE_MS. */
  totalDeadlineMs?: number;
}

/**
 * Resolve a thumbnail URL for each row that has one, in ONE batched call, and
 * attach it to the row. Fail-closed: any error leaves every row imageless and
 * the export continues with placeholders (Brief section 3.3).
 */
export async function attachExportImages(
  ctx: ServiceContext,
  rows: InventoryExportSourceRow[],
  opts: { imageSize: keyof typeof EXPORT_IMAGE_TARGET_WIDTH_PX },
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const service = new ItemImagesService(ctx);
    const urls = await service.primaryImagesForServerDecoding(
      rows.map((r) => r.id),
      EXPORT_IMAGE_TARGET_WIDTH_PX[opts.imageSize],
    );
    for (const row of rows) {
      const url = urls.get(row.id);
      row.image = url ? { thumbnailUrl: url } : null;
    }
  } catch {
    // Swallow and blank, exactly like buildInventoryExportRows' safe() wrapper.
    // Never log: the message can carry a signed URL.
    for (const row of rows) row.image = null;
  }
}

/**
 * How many of these items have a usable image, WITHOUT signing anything.
 *
 * Readiness ("84 of 111 have a cover") only needs presence, and signing is the
 * expensive half of the resolver — so this is two plain selects and no Storage
 * round trip at all.
 */
export async function countRowsWithImages(
  ctx: ServiceContext,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0;
  try {
    const withRow = new Set<string>();
    const { data } = await ctx.supabase
      .from('item_images')
      .select('item_id')
      .eq('organization_id', ctx.organizationId)
      .in('item_id', itemIds);
    for (const row of (data ?? []) as Array<{ item_id: string }>) withRow.add(row.item_id);

    const rest = itemIds.filter((id) => !withRow.has(id));
    if (rest.length > 0) {
      const { data: cfRows } = await ctx.supabase
        .from('inventory_items')
        .select('id, custom_fields')
        .eq('organization_id', ctx.organizationId)
        .in('id', rest);
      for (const row of (cfRows ?? []) as Array<{
        id: string;
        custom_fields: Record<string, unknown> | null;
      }>) {
        const url = row.custom_fields?.thumbnail_url;
        if (typeof url === 'string' && url.length > 0) withRow.add(row.id);
      }
    }
    return withRow.size;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch machinery                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One pause shared by every worker of ONE fetchExportImageBytes call. When any
 * attempt is throttled (429) it pushes `pauseUntil` forward, and every worker
 * waits for that instant before starting its next request — so one throttled
 * worker slows the whole burst instead of its siblings continuing to hammer
 * the same origin. Deliberately per-call, never module-level: two exports
 * from two organizations must not share throttling state.
 */
class RateGate {
  private pauseUntil = 0;

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /** Wait out an active pause. A single sleep, never a loop, so an injected
   *  no-op sleep in tests cannot spin forever. */
  async waitTurn(): Promise<void> {
    const wait = this.pauseUntil - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  throttle(ms: number): void {
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + ms);
  }
}

interface FetchDeps {
  fetchImpl: typeof fetch;
  decodeWebp: (bytes: Uint8Array, targetWidth: number) => Promise<EmbeddedImage | null>;
  targetWidth: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  gate: RateGate;
  /** Absolute clock value after which no attempt may start. */
  deadlineAt: number;
}

type AttemptOutcome =
  | { kind: 'ok'; image: EmbeddedImage }
  | { kind: 'skip'; reason: ImageSkipReason }
  | { kind: 'retry'; reason: 'rateLimited' | 'timeout' | 'other'; retryAfterMs: number | null };

interface FetchOneResult {
  image: EmbeddedImage | null;
  reason: ImageSkipReason | null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Magic-byte sniff. Wins over the content-type header when it recognises the body. */
export function sniffImageFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.byteLength >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'webp';
  }
  return null;
}

/** Retry-After as milliseconds: integer seconds or an HTTP-date. null when absent/unparseable. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Wait before attempt `attempt + 1`, given `attempt` just failed (1-based). */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  const jitter = Math.floor(random() * 100);
  const computed = IMAGE_FETCH_BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitter;
  const wanted = retryAfterMs !== null ? Math.max(retryAfterMs, computed) : computed;
  return Math.min(wanted, IMAGE_FETCH_BACKOFF_CAP_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * One HTTP attempt: fetch, classify the response, stream the body under the
 * hard byte cap, then classify the bytes by magic (falling back to the
 * declared content type) and decode WebP. Never throws.
 */
async function attemptOnce(url: string, deps: FetchDeps): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await deps.fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      if (isRetryableStatus(res.status)) {
        return {
          kind: 'retry',
          reason: res.status === 429 ? 'rateLimited' : 'other',
          retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after'), deps.now()),
        };
      }
      return { kind: 'skip', reason: 'other' };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const declaredKind = READABLE_CONTENT_TYPES.get(contentType);
    if (!declaredKind) return { kind: 'skip', reason: 'unsupported' };
    // Cheap fast path: an HONESTLY declared oversized body is rejected
    // without even opening the stream.
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_EMBEDDED_IMAGE_BYTES) return { kind: 'skip', reason: 'oversized' };

    // HARD cap. `content-length` cannot be trusted on its own: it can be
    // absent, zero, or (from a hostile or merely misconfigured origin)
    // understated. Buffering the whole body first via res.arrayBuffer() and
    // checking size only afterward — the previous approach — lets an
    // attacker force this serverless function to hold an unbounded body in
    // memory before the check ever runs. Instead, stream the body and bail
    // out the instant the running total crosses the cap, so we never hold
    // more than MAX_EMBEDDED_IMAGE_BYTES plus at most one in-flight chunk.
    let buf: Uint8Array;
    const reader = res.body?.getReader();
    if (!reader) {
      // Some runtimes/mocks don't expose a real ReadableStream body (a
      // Response built without one, or certain test doubles). Real fetch()
      // responses in this codebase's runtimes (Node/undici locally, the
      // platform's edge/node fetch in production) always provide res.body,
      // so this branch is a documented fallback, not the common path — it
      // keeps the POST-download size check as a backstop but is NOT hardened
      // against an oversized body the way the streaming path above is.
      buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_EMBEDDED_IMAGE_BYTES) return { kind: 'skip', reason: 'oversized' };
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
        if (total > MAX_EMBEDDED_IMAGE_BYTES) {
          // Release the reader and tear down the connection immediately —
          // never keep pulling once we know the body is oversized.
          // Under real undici, cancel() on a reader whose request was just
          // aborted REJECTS with AbortError; awaiting it bare would land in the
          // catch below and turn a definitive 'oversized' skip into a retry
          // that re-streams the same oversized body up to four times (found by
          // the 2026-08-18 verifier against a real http server). Fire-and-
          // forget the cancel and swallow its rejection; the abort already
          // tore the connection down.
          controller.abort();
          void reader.cancel().catch(() => {});
          return { kind: 'skip', reason: 'oversized' };
        }
      }
      buf = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    if (buf.byteLength === 0) return { kind: 'skip', reason: 'other' };

    // Magic wins over the header: a WebP served as octet-stream (or even as
    // image/png) is still WebP, and a PNG served as image/webp is still PNG.
    // Only when the magic is unrecognised do we trust the declared type —
    // that keeps png/jpeg bytes passing through byte-for-byte as before.
    const format = sniffImageFormat(buf) ?? declaredKind;
    if (format === 'png' || format === 'jpeg') return { kind: 'ok', image: { data: buf, extension: format } };
    if (format === 'webp') {
      // The seam is contracted never to throw, but a throw here is a decode
      // failure, not a network failure: final, never retried.
      const decoded = await deps.decodeWebp(buf, deps.targetWidth).catch(() => null);
      return decoded ? { kind: 'ok', image: decoded } : { kind: 'skip', reason: 'unsupported' };
    }
    return { kind: 'skip', reason: 'unsupported' };
  } catch {
    // Timeout, DNS, reset, abort. Never log — the URL carries a signed token.
    return { kind: 'retry', reason: timedOut ? 'timeout' : 'other', retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one URL with retry + backoff, honouring the shared RateGate and the
 * call-wide deadline. Retries only on 429/408/5xx, network errors and the
 * per-attempt timeout; a 404, a disallowed content type or an oversized body
 * is final on the first attempt.
 */
async function fetchOne(url: string, deps: FetchDeps): Promise<FetchOneResult> {
  let lastRetryReason: ImageSkipReason = 'other';
  for (let attempt = 1; attempt <= IMAGE_FETCH_MAX_ATTEMPTS; attempt++) {
    await deps.gate.waitTurn();
    // Checked AFTER the gate: waiting out a pause can carry us past the
    // deadline, and nothing — first attempt or retry — may start after it.
    // A never-started entry is a 'deadline' skip; an entry that already
    // failed reports the reason its last attempt failed for.
    if (deps.now() >= deps.deadlineAt) {
      return { image: null, reason: attempt === 1 ? 'deadline' : lastRetryReason };
    }
    const outcome = await attemptOnce(url, deps);
    if (outcome.kind === 'ok') return { image: outcome.image, reason: null };
    if (outcome.kind === 'skip') return { image: null, reason: outcome.reason };
    lastRetryReason = outcome.reason;
    if (attempt === IMAGE_FETCH_MAX_ATTEMPTS) break;
    const backoff = computeBackoffMs(attempt, outcome.retryAfterMs, deps.random);
    // Do not sleep out a backoff that ends past the deadline: the next
    // iteration would only discover the deadline after the wait, burning up
    // to IMAGE_FETCH_BACKOFF_CAP_MS of the route's budget for nothing.
    if (deps.now() + backoff >= deps.deadlineAt) {
      return { image: null, reason: lastRetryReason };
    }
    if (outcome.reason === 'rateLimited') {
      // Slow EVERY worker, not just this one; this worker then waits at the
      // gate at the top of the next iteration.
      deps.gate.throttle(backoff);
    } else {
      await deps.sleep(backoff);
    }
  }
  return { image: null, reason: lastRetryReason };
}

function emptySkipCounts(): ImageSkipCounts {
  return { rateLimited: 0, timeout: 0, unsupported: 0, oversized: 0, other: 0, deadline: 0 };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetch image bytes for embedding, bounded on every axis: per-image size,
 * total size, image count, per-request timeout, retries with backoff, a
 * shared rate gate, parallelism and a whole-call deadline. A failure never
 * propagates — the caller draws a placeholder for the missing id and reads
 * `skippedReasons` for why.
 */
export async function fetchExportImageBytes(
  urls: ReadonlyMap<string, string>,
  opts: FetchExportImageBytesOptions = {},
): Promise<FetchExportImageBytesResult> {
  const now = opts.now ?? (() => Date.now());
  const deps: FetchDeps = {
    fetchImpl: opts.fetchImpl ?? fetch,
    decodeWebp: opts.decodeWebp ?? webpToPng,
    targetWidth: opts.targetWidth ?? EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    sleep: opts.sleep ?? defaultSleep,
    now,
    random: opts.random ?? Math.random,
    gate: new RateGate(now, opts.sleep ?? defaultSleep),
    deadlineAt: now() + (opts.totalDeadlineMs ?? IMAGE_FETCH_TOTAL_DEADLINE_MS),
  };
  const entries = [...urls.entries()].slice(0, MAX_EMBEDDED_IMAGES);
  const truncatedByCount = urls.size > MAX_EMBEDDED_IMAGES;

  const images = new Map<string, EmbeddedImage>();
  const skippedReasons = emptySkipCounts();
  let skipped = 0;
  let totalBytes = 0;
  let budgetSpent = false;

  // Per-request URL cache, scoped to THIS call only — a plain local Map,
  // deliberately NOT module-level state. Two rows commonly resolve to the
  // identical signed URL (e.g. a shared cover image), and without this a
  // duplicate would burn a second concurrency slot on a redundant fetch AND
  // double-count its bytes against MAX_TOTAL_EMBEDDED_IMAGE_BYTES. A
  // module-level cache would be worse than no cache at all: it would leak
  // image bytes — and the signed URLs themselves — across unrelated export
  // requests and across different ORGANIZATIONS, since nothing here is keyed
  // by org or request. That is a tenant-isolation bug, not a missed
  // optimization, so this cache must be created fresh on every call and go
  // out of scope when the call returns. Both a successful fetch and a
  // definitive skip are memoized, so a repeated URL costs nothing either way.
  const cache = new Map<string, FetchOneResult>();
  const inFlight = new Map<string, Promise<FetchOneResult>>();

  // Resolves a URL through the cache. Only the caller that actually CREATES
  // the in-flight promise (the "owner") is allowed to charge its bytes
  // against the total budget below — every other caller for the same URL,
  // however many, is a "waiter" that reuses the result for free. The
  // owner/waiter decision is made with a synchronous check-then-set (no
  // `await` in between), so it stays correct even with several concurrent
  // workers racing on the same duplicate URL.
  const resolveUrl = (url: string): { promise: Promise<FetchOneResult>; isOwner: boolean } => {
    const cached = cache.get(url);
    if (cached) return { promise: Promise.resolve(cached), isOwner: false };
    const existing = inFlight.get(url);
    if (existing) return { promise: existing, isOwner: false };
    const promise = fetchOne(url, deps).then((result) => {
      cache.set(url, result);
      return result;
    });
    inFlight.set(url, promise);
    return { promise, isOwner: true };
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (budgetSpent) return;
      const index = cursor++;
      if (index >= entries.length) return;
      const [id, url] = entries[index]!;
      // The deadline is enforced inside fetchOne, after the gate wait and
      // before EVERY attempt: an entry reached after the deadline resolves
      // to a 'deadline' skip without a single request being started.
      const { promise, isOwner } = resolveUrl(url);
      const result = await promise;
      if (!result.image) {
        skipped++;
        skippedReasons[result.reason ?? 'other']++;
        continue;
      }
      if (isOwner) {
        // Only charge the total budget once per de-duplicated URL — a
        // waiter reusing a cached image must NOT add its bytes again.
        if (totalBytes + result.image.data.byteLength > MAX_TOTAL_EMBEDDED_IMAGE_BYTES) {
          budgetSpent = true;
          return;
        }
        totalBytes += result.image.data.byteLength;
      }
      images.set(id, result.image);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, entries.length) }, () => worker()),
  );

  return {
    images,
    skipped,
    truncated: truncatedByCount || budgetSpent || skippedReasons.deadline > 0,
    skippedReasons,
  };
}
