import { beforeEach, describe, expect, it, vi } from 'vitest';

const primaryImagesForServerDecoding = vi.fn();

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: vi.fn().mockImplementation(() => ({ primaryImagesForServerDecoding })),
}));

import { ItemImagesService } from '@/server/services/item-images';

import { readImageDimensions } from '@/lib/inventory-export-xlsx';

import {
  attachExportImages,
  EXPORT_IMAGE_TARGET_WIDTH_PX,
  EXPORT_TOO_MANY_IMAGES_MESSAGE,
  fetchExportImageBytes,
  IMAGE_FETCH_BACKOFF_BASE_MS,
  IMAGE_FETCH_BACKOFF_CAP_MS,
  IMAGE_FETCH_CONCURRENCY,
  IMAGE_FETCH_MAX_ATTEMPTS,
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_TOTAL_EMBEDDED_IMAGE_BYTES,
  type EmbeddedImage,
} from './export-images';
import { webpToPng } from './webp-to-png';
import { inventoryExportRequestSchema, resolveExportFields } from './export-request';
import type { InventoryExportSourceRow } from './source-row';

import type { Permission } from '@stockpilot/core';

const ctx = {} as never;
const allow = (_p: Permission) => true;

function makeRow(id: string): InventoryExportSourceRow {
  return {
    id,
    itemType: 'book',
    name: `Book ${id}`,
    sku: `BK-${id}`,
    barcode: '',
    status: 'active',
    quantityOnHand: 1,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: null,
    retailPrice: null,
    category: '',
    primaryLocation: '',
    supplier: '',
    warehouse: '',
    charter: 'Generic',
    trackingType: 'none',
    author: '',
    isbn: '',
    grade: '',
    rackNumber: '',
    rackRow: '',
    crateColor: '',
    crateNumber: '',
    rackLabel: '',
    crateLabel: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    image: null,
    legacyRawBookFields: {
      grade: '',
      rackNumber: '',
      rackRow: '',
      crateColor: '',
      crateNumber: '',
    },
  };
}

function jpegResponse(bytes: number, contentType = 'image/jpeg'): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes) },
  });
}

/**
 * Builds a Response whose body is a real ReadableStream we can instrument.
 * `pulledSizes` records the size of every chunk the underlying source was
 * actually asked to produce — this is how the streaming tests prove the
 * implementation stopped EARLY (never pulled the whole body) rather than
 * merely rejecting an already-fully-buffered oversized array.
 */
function streamedResponse(
  chunkSizes: number[],
  opts: { contentType?: string; contentLength?: string } = {},
): { response: Response; pulledSizes: number[] } {
  const pulledSizes: number[] = [];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunkSizes.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[index]!;
      index++;
      pulledSizes.push(size);
      controller.enqueue(new Uint8Array(size));
    },
  });
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'image/jpeg' };
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength;
  const response = new Response(stream, { status: 200, headers });
  return { response, pulledSizes };
}

beforeEach(() => {
  // This repo's global src/test/setup.ts runs `vi.restoreAllMocks()` after
  // every test, which wipes the `.mockImplementation()` set at module load
  // above (not just call history) — the same reason inventory-export.test.ts
  // re-establishes its five service mocks here instead of only resetting the
  // inner spies. Without this, every test after the first sees `new
  // ItemImagesService()` return undefined and silently fails closed with
  // zero calls to primaryImagesForServerDecoding.
  vi.mocked(ItemImagesService).mockImplementation(
    () => ({ primaryImagesForServerDecoding }) as never,
  );
  primaryImagesForServerDecoding.mockReset();
});

describe('attachExportImages', () => {
  it('asks the server-decoding resolver ONCE for every id, never per row', async () => {
    primaryImagesForServerDecoding.mockResolvedValue(
      new Map([
        ['a', 'https://signed.example/a.webp'],
        ['b', 'https://signed.example/b.webp'],
      ]),
    );
    const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
    await attachExportImages(ctx, rows, { imageSize: 'medium' });
    expect(primaryImagesForServerDecoding).toHaveBeenCalledTimes(1);
    expect(primaryImagesForServerDecoding).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    );
    expect(rows[0]!.image).toEqual({ thumbnailUrl: 'https://signed.example/a.webp' });
    expect(rows[2]!.image).toBeNull();
  });

  it('scales the requested thumbnail width with the chosen image size', async () => {
    primaryImagesForServerDecoding.mockResolvedValue(new Map());
    await attachExportImages(ctx, [makeRow('a')], { imageSize: 'large' });
    expect(primaryImagesForServerDecoding).toHaveBeenCalledWith(['a'], 320);
  });

  it('FAILS CLOSED — a resolver throw leaves every row imageless instead of failing the export', async () => {
    primaryImagesForServerDecoding.mockRejectedValue(new Error('storage unavailable'));
    const rows = [makeRow('a')];
    await expect(attachExportImages(ctx, rows, { imageSize: 'small' })).resolves.toBeUndefined();
    expect(rows[0]!.image).toBeNull();
  });

  it('does nothing at all for an empty row set', async () => {
    await attachExportImages(ctx, [], { imageSize: 'small' });
    expect(primaryImagesForServerDecoding).not.toHaveBeenCalled();
  });
});

describe('fetchExportImageBytes', () => {
  it('fetches every URL and reports the extension from the content type', async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(1024));
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(skipped).toBe(0);
    expect(images.get('a')!.extension).toBe('jpeg');
    expect(images.get('a')!.data.byteLength).toBe(1024);
  });

  it('skips an oversized image and keeps going', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('big.jpg') ? jpegResponse(MAX_EMBEDDED_IMAGE_BYTES + 1) : jpegResponse(512),
    );
    const { images, skipped } = await fetchExportImageBytes(
      new Map([
        ['big', 'https://signed.example/big.jpg'],
        ['ok', 'https://signed.example/ok.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.has('big')).toBe(false);
    expect(images.has('ok')).toBe(true);
    expect(skipped).toBe(1);
  });

  it('skips unsupported content types — SVG, GIF and HTML are never embedded, and never retried', async () => {
    // SVG is a script carrier; exceljs accepts only png/jpeg/gif and react-pdf
    // only png/jpeg. (WebP used to be on this list; it is now decoded to PNG
    // server-side — see the "WebP" describe below.)
    for (const type of ['image/svg+xml', 'image/gif', 'text/html']) {
      const fetchImpl = vi.fn(async () => jpegResponse(256, type));
      const { images, skipped, skippedReasons } = await fetchExportImageBytes(
        new Map([['a', 'https://signed.example/a.bin']]),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(images.size, type).toBe(0);
      expect(skipped, type).toBe(1);
      expect(skippedReasons.unsupported, type).toBe(1);
      expect(fetchImpl, type).toHaveBeenCalledTimes(1);
    }
  });

  it('skips a non-200 response and a thrown fetch without failing the batch', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('404.jpg')) return new Response('nope', { status: 404 });
      if (url.endsWith('boom.jpg')) throw new Error('ECONNRESET');
      return jpegResponse(128);
    });
    const sleep = vi.fn(async () => {});
    const { images, skipped, skippedReasons } = await fetchExportImageBytes(
      new Map([
        ['a', 'https://signed.example/404.jpg'],
        ['b', 'https://signed.example/boom.jpg'],
        ['c', 'https://signed.example/ok.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep },
    );
    expect(images.size).toBe(1);
    expect(images.has('c')).toBe(true);
    expect(skipped).toBe(2);
    expect(skippedReasons.other).toBe(2);
  });

  it('stops once the total byte budget is spent and reports truncation', async () => {
    const big = 400 * 1024;
    const fetchImpl = vi.fn(async () => jpegResponse(big));
    const urls = new Map(
      Array.from({ length: 200 }, (_, i) => [`i${i}`, `https://signed.example/${i}.jpg`] as const),
    );
    const { images, truncated } = await fetchExportImageBytes(urls, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(truncated).toBe(true);
    const total = [...images.values()].reduce((sum, img) => sum + img.data.byteLength, 0);
    expect(total).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it('never logs a signed URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg?token=SECRET-TOKEN']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    );
    for (const spy of [warn, error]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('SECRET-TOKEN');
        expect(JSON.stringify(call)).not.toContain('signed.example');
      }
    }
    warn.mockRestore();
    error.mockRestore();
  });
});

/**
 * Finding 1 (Important, fix wave): the byte cap must be HARD. Before this
 * fix, `fetchOne` only rejected pre-download when `content-length` was
 * present AND accurate; if the header was missing, zero, or understated,
 * the whole body was buffered via `res.arrayBuffer()` before the
 * post-download size check ran. A hostile or misconfigured origin could
 * force this serverless function to buffer an unbounded body in memory.
 * These tests prove the guard now stops READING the stream early — not
 * just that it eventually rejects the fully-buffered result.
 */
describe('fetchExportImageBytes — hard byte cap (streaming)', () => {
  it('content-length ABSENT + oversized body: image is skipped and the stream is abandoned early', async () => {
    // 5 chunks of 300KB. The 512KB (MAX_EMBEDDED_IMAGE_BYTES) cap is
    // crossed partway through chunk 2 (300KB + 300KB = 600KB > 512KB), so a
    // hard guard must never reach chunk 5.
    const chunkSizes = [300 * 1024, 300 * 1024, 300 * 1024, 300 * 1024, 300 * 1024];
    const { response, pulledSizes } = streamedResponse(chunkSizes); // no content-length header at all
    const fetchImpl = vi.fn(async () => response);
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.has('a')).toBe(false);
    expect(skipped).toBe(1);
    // The hard proof: the implementation must not have pulled every chunk.
    // A soft (post-buffer) cap would drain the whole 5-chunk stream first.
    expect(pulledSizes.length).toBeLessThan(chunkSizes.length);
  });

  it('content-length UNDERSTATED (declares small, body is large): skipped, stream abandoned early', async () => {
    const chunkSizes = [300 * 1024, 300 * 1024, 300 * 1024, 300 * 1024, 300 * 1024];
    const { response, pulledSizes } = streamedResponse(chunkSizes, { contentLength: '100' });
    const fetchImpl = vi.fn(async () => response);
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.has('a')).toBe(false);
    expect(skipped).toBe(1);
    expect(pulledSizes.length).toBeLessThan(chunkSizes.length);
  });

  it('a normal small image still succeeds unchanged (no regression)', async () => {
    // Multiple small chunks below the cap — proves the streamed
    // reassembly produces byte-identical, correctly sized output.
    const chunkSizes = [40 * 1024, 40 * 1024, 20 * 1024];
    const { response } = streamedResponse(chunkSizes);
    const fetchImpl = vi.fn(async () => response);
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(skipped).toBe(0);
    expect(images.get('a')!.extension).toBe('jpeg');
    expect(images.get('a')!.data.byteLength).toBe(100 * 1024);
  });
});

/**
 * Finding 2 (Important, fix wave): per-request URL cache. Two rows can
 * resolve to the identical signed URL (e.g. a shared cover image). Without
 * a cache, each duplicate wastes a concurrency slot on a redundant network
 * call AND double-counts its bytes against MAX_TOTAL_EMBEDDED_IMAGE_BYTES.
 */
describe('fetchExportImageBytes — per-request URL cache', () => {
  it('two rows sharing one image URL: exactly ONE fetch call, both rows get the image', async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(1024));
    const { images, skipped } = await fetchExportImageBytes(
      new Map([
        ['row-a', 'https://signed.example/shared.jpg'],
        ['row-b', 'https://signed.example/shared.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(images.has('row-a')).toBe(true);
    expect(images.has('row-b')).toBe(true);
    expect(images.get('row-a')!.data.byteLength).toBe(1024);
    expect(images.get('row-b')!.data.byteLength).toBe(1024);
    expect(skipped).toBe(0);
  });

  it('charges a de-duplicated URL against the total budget ONCE, not per row', async () => {
    // Each row's image sits just under the PER-IMAGE cap (512KB), so there
    // is no way to demonstrate the double-counting bug with only two rows
    // — 2 x 512KB is nowhere near the 24MB total cap. Instead this uses
    // enough rows sharing ONE url that charging it once per OCCURRENCE
    // (the bug) blows the total cap and starts silently dropping rows,
    // while charging it once per URL (the fix) leaves ~98% of the budget
    // untouched. Real exported constants throughout — no overrides.
    const perImageBytes = 500 * 1024; // under MAX_EMBEDDED_IMAGE_BYTES (512KB)
    const rowCount = 50; // 50 * 500KB ≈ 24.4MB > MAX_TOTAL_EMBEDDED_IMAGE_BYTES (24MB)
    expect(rowCount * perImageBytes).toBeGreaterThan(MAX_TOTAL_EMBEDDED_IMAGE_BYTES);
    expect(perImageBytes).toBeLessThan(MAX_EMBEDDED_IMAGE_BYTES);

    const fetchImpl = vi.fn(async () => jpegResponse(perImageBytes));
    const sharedUrl = 'https://signed.example/shared-budget.jpg';
    const urls = new Map(
      Array.from({ length: rowCount }, (_, i) => [`row-${i}`, sharedUrl] as const),
    );
    const { images, truncated } = await fetchExportImageBytes(urls, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(images.size).toBe(rowCount);
    expect(truncated).toBe(false);
  });
});

describe('fetchExportImageBytes — coverage gaps (Minor, fix wave)', () => {
  it('aborts a hung fetch once IMAGE_FETCH_TIMEOUT_MS elapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
            // Never resolves on its own — simulates a hung connection.
          }),
      );
      const pending = fetchExportImageBytes(
        new Map([['a', 'https://signed.example/a.jpg']]),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      // Every attempt hangs, so each one is cut off by the per-attempt
      // timer, then backed off, then retried — up to IMAGE_FETCH_MAX_ATTEMPTS.
      for (let i = 0; i < IMAGE_FETCH_MAX_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(IMAGE_FETCH_TIMEOUT_MS + IMAGE_FETCH_BACKOFF_CAP_MS);
      }
      const { images, skipped, skippedReasons } = await pending;
      expect(images.size).toBe(0);
      expect(skipped).toBe(1);
      expect(skippedReasons.timeout).toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs more than IMAGE_FETCH_CONCURRENCY fetches at once', async () => {
    let current = 0;
    let max = 0;
    const fetchImpl = vi.fn(async () => {
      current++;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current--;
      return jpegResponse(256);
    });
    const urls = new Map(
      Array.from({ length: 20 }, (_, i) => [`i${i}`, `https://signed.example/${i}.jpg`] as const),
    );
    await fetchExportImageBytes(urls, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(max).toBeLessThanOrEqual(IMAGE_FETCH_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
  });
});

describe('EXPORT_TOO_MANY_IMAGES_MESSAGE', () => {
  it('is the exact copy the brief specifies', () => {
    expect(EXPORT_TOO_MANY_IMAGES_MESSAGE).toBe(
      'This export contains too many embedded images. Reduce the number of records, choose smaller images, or export without images.',
    );
  });
});

/**
 * CONTROLLER RIDER (inherited from Task 6's reviews).
 *
 * Task 6's "zero image work for CSV" test could only assert the OUTPUT field
 * was null, because no image code existed yet to spy on. Now it does — this
 * is the executable proof of Global Constraint 10 ("no image work unless the
 * export asked for it") at the exact seam where a real orchestrator (Task 11
 * PDF/XLSX pipeline, Task 13 CSV image-URL column) will make the decision:
 * Task 5's `resolveExportFields` is the ONE authoritative place that computes
 * `imagesRequested` from a (possibly hostile) client request, and this
 * module's `attachExportImages` is the ONE place that does the batched
 * lookup. Gating the real `attachExportImages` call on the real
 * `imagesRequested` output — rather than a hand-rolled boolean — proves the
 * two tasks compose the way GC10 requires, not just that each one
 * individually behaves in isolation.
 */
describe('GC10 — batched image work is opt-in only (rider)', () => {
  function resolve(format: 'csv' | 'xlsx' | 'pdf', fields: string[], includeImages: boolean) {
    const options = inventoryExportRequestSchema.parse({
      format,
      scope: 'all',
      fields,
      options: { includeImages, imageMode: 'embedded' },
    }).options;
    return resolveExportFields({ fields, itemType: 'product', format, options, can: allow });
  }

  it('NEVER calls the image resolver for a plain CSV export (no image field, includeImages false)', async () => {
    primaryImagesForServerDecoding.mockResolvedValue(new Map());
    const resolved = resolve('csv', ['name', 'sku'], false);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.imagesRequested).toBe(false);

    const rows = [makeRow('a'), makeRow('b')];
    // This mirrors the ONLY decision an orchestrator is allowed to make:
    // call attachExportImages if and only if resolveExportFields said so.
    if (resolved.imagesRequested) {
      await attachExportImages(ctx, rows, { imageSize: 'medium' });
    }

    expect(primaryImagesForServerDecoding).not.toHaveBeenCalled();
    expect(rows[0]!.image).toBeNull();
    expect(rows[1]!.image).toBeNull();
  });

  it('calls the image resolver exactly ONCE, batched not per-row, when the export selects the Image field', async () => {
    primaryImagesForServerDecoding.mockResolvedValue(
      new Map([
        ['a', 'https://signed.example/a.webp'],
        ['b', 'https://signed.example/b.webp'],
        ['c', 'https://signed.example/c.webp'],
      ]),
    );
    const resolved = resolve('xlsx', ['name', 'sku', 'image'], true);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.imagesRequested).toBe(true);

    const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
    if (resolved.imagesRequested) {
      await attachExportImages(ctx, rows, { imageSize: 'medium' });
    }

    expect(primaryImagesForServerDecoding).toHaveBeenCalledTimes(1);
    expect(primaryImagesForServerDecoding).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    );
    for (const row of rows) {
      expect(row.image).not.toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2026-08-18: 429s from the transform endpoint left blank cells. Retry with  */
/* backoff, a shared rate gate, a whole-call deadline, and WebP decoded here. */
/* -------------------------------------------------------------------------- */

/**
 * A clock the code under test reads through `now` and advances through
 * `sleep`. `sleep` resolves after a REAL 2ms tick and then moves the clock to
 * at least `start + ms`, so a worker that is genuinely waiting on the gate
 * observes the pause, while a worker that skipped the gate would read the
 * un-advanced clock — which is exactly what the gate test asserts on.
 */
function fakeClock() {
  let t = 0;
  const sleep = vi.fn(async (ms: number) => {
    const target = t + ms;
    await new Promise((resolve) => setTimeout(resolve, 2));
    t = Math.max(t, target);
  });
  return { now: () => t, sleep, random: () => 0, advance: (ms: number) => void (t += ms) };
}

function statusResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('x', { status, headers });
}

function fetchSequence(...responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (next instanceof Error) throw next;
    return next;
  });
}

describe('fetchExportImageBytes — retry with backoff', () => {
  const one = new Map([['a', 'https://signed.example/a.jpg']]);

  it('429 then 200: embedded after exactly two fetch calls and ONE backoff sleep', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429), jpegResponse(64));
    const { images, skipped, skippedReasons } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(images.get('a')!.data.byteLength).toBe(64);
    expect(skipped).toBe(0);
    expect(skippedReasons.rateLimited).toBe(0);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep.mock.calls[0]![0]).toBe(IMAGE_FETCH_BACKOFF_BASE_MS);
  });

  it('429 on every attempt: skipped as rateLimited after exactly IMAGE_FETCH_MAX_ATTEMPTS calls', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429));
    const { images, skipped, skippedReasons } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(IMAGE_FETCH_MAX_ATTEMPTS);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(images.size).toBe(0);
    expect(skipped).toBe(1);
    expect(skippedReasons.rateLimited).toBe(1);
  });

  it('backoff doubles per attempt: 250, 500, 1000 (jitter pinned to 0)', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429));
    await fetchExportImageBytes(one, { fetchImpl: fetchImpl as unknown as typeof fetch, ...clock });
    expect(clock.sleep.mock.calls.map((c) => c[0])).toEqual([250, 500, 1000]);
  });

  it('404: ONE call, skipped as other, never retried', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(404), jpegResponse(64));
    const { images, skipped, skippedReasons } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(images.size).toBe(0);
    expect(skipped).toBe(1);
    expect(skippedReasons.other).toBe(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('a disallowed content type and an oversized body are final on the first attempt', async () => {
    const clock = fakeClock();
    const svg = fetchSequence(jpegResponse(64, 'image/svg+xml'), jpegResponse(64));
    const svgResult = await fetchExportImageBytes(one, {
      fetchImpl: svg as unknown as typeof fetch,
      ...clock,
    });
    expect(svg).toHaveBeenCalledTimes(1);
    expect(svgResult.skippedReasons.unsupported).toBe(1);

    const big = fetchSequence(jpegResponse(MAX_EMBEDDED_IMAGE_BYTES + 1), jpegResponse(64));
    const bigResult = await fetchExportImageBytes(one, {
      fetchImpl: big as unknown as typeof fetch,
      ...clock,
    });
    expect(big).toHaveBeenCalledTimes(1);
    expect(bigResult.skippedReasons.oversized).toBe(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('500 then 200: embedded (5xx is retryable)', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(500), jpegResponse(64));
    const { images, skipped } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(images.has('a')).toBe(true);
    expect(skipped).toBe(0);
  });

  it('408 then 200: embedded (request timeout status is retryable)', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(408), jpegResponse(64));
    const { images } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(images.has('a')).toBe(true);
  });

  it('network throw then 200: embedded', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(new Error('ECONNRESET'), jpegResponse(64));
    const { images, skipped } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(images.has('a')).toBe(true);
    expect(skipped).toBe(0);
  });

  it('honours Retry-After in seconds: the wait is at least 2000ms', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429, { 'retry-after': '2' }), jpegResponse(64));
    const { images } = await fetchExportImageBytes(one, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(images.has('a')).toBe(true);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(2000);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const clock = fakeClock();
    // Fake clock starts at epoch 0; a date 3s later means "wait 3000ms".
    const date = new Date(3000).toUTCString();
    const fetchImpl = fetchSequence(statusResponse(429, { 'retry-after': date }), jpegResponse(64));
    await fetchExportImageBytes(one, { fetchImpl: fetchImpl as unknown as typeof fetch, ...clock });
    expect(clock.sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(3000);
  });

  it('caps a huge Retry-After at IMAGE_FETCH_BACKOFF_CAP_MS (4000)', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429, { 'retry-after': '30' }), jpegResponse(64));
    await fetchExportImageBytes(one, { fetchImpl: fetchImpl as unknown as typeof fetch, ...clock });
    expect(clock.sleep.mock.calls[0]![0]).toBe(IMAGE_FETCH_BACKOFF_CAP_MS);
    expect(clock.sleep.mock.calls[0]![0]).toBe(4000);
  });

  it('a per-attempt timeout is retried: hung first attempt, 200 second attempt', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        calls++;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        }
        return Promise.resolve(jpegResponse(64));
      });
      const pending = fetchExportImageBytes(one, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      });
      await vi.advanceTimersByTimeAsync(IMAGE_FETCH_TIMEOUT_MS + 1);
      const { images, skipped } = await pending;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(images.has('a')).toBe(true);
      expect(skipped).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchExportImageBytes — shared adaptive rate gate', () => {
  it('one 429 pauses EVERY worker: no sibling starts its next request before pauseUntil', async () => {
    const clock = fakeClock();
    const startedAt: Array<{ url: string; at: number }> = [];
    let throttledOnce = false;
    const fetchImpl = vi.fn(async (url: string) => {
      startedAt.push({ url, at: clock.now() });
      if (url.endsWith('/0.jpg') && !throttledOnce) {
        // The throttled worker learns about the 429 immediately...
        throttledOnce = true;
        return statusResponse(429);
      }
      // ...while every sibling's first request is still in flight for a
      // real tick, so the gate is already set when they go for their next.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return jpegResponse(32);
    });
    const urls = new Map(
      Array.from({ length: 12 }, (_, i) => [`i${i}`, `https://signed.example/${i}.jpg`] as const),
    );
    const { images, skipped } = await fetchExportImageBytes(urls, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
    });
    expect(images.size).toBe(12);
    expect(skipped).toBe(0);
    // Six workers start at t=0 (the first burst, before any 429 was seen).
    const first = startedAt.slice(0, IMAGE_FETCH_CONCURRENCY);
    expect(first.every((s) => s.at === 0)).toBe(true);
    // Everything after that — the OTHER workers' second requests as well as
    // the retry itself — starts no earlier than the pause the 429 set
    // (base backoff, jitter pinned to 0).
    const rest = startedAt.slice(IMAGE_FETCH_CONCURRENCY);
    expect(rest.length).toBe(13 - IMAGE_FETCH_CONCURRENCY); // 12 entries + 1 retry
    for (const s of rest) {
      expect(s.at, `${s.url} started at ${s.at}`).toBeGreaterThanOrEqual(IMAGE_FETCH_BACKOFF_BASE_MS);
    }
    const siblings = rest.filter((s) => !s.url.endsWith('/0.jpg'));
    expect(siblings.length).toBeGreaterThan(0);
  });
});

describe('fetchExportImageBytes — whole-call deadline', () => {
  it('skips the remaining entries as deadline once the deadline passes and starts no fetch after it', async () => {
    const clock = fakeClock();
    const startedAt: number[] = [];
    // Each fetch costs a simulated second; the deadline is five.
    const fetchImpl = vi.fn(async () => {
      startedAt.push(clock.now());
      clock.advance(1000);
      return jpegResponse(32);
    });
    const urls = new Map(
      Array.from({ length: 10 }, (_, i) => [`i${i}`, `https://signed.example/${i}.jpg`] as const),
    );
    const { images, skipped, truncated, skippedReasons } = await fetchExportImageBytes(urls, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...clock,
      totalDeadlineMs: 5000,
    });
    expect(startedAt.every((at) => at < 5000)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(images.size).toBe(5);
    expect(skipped).toBe(5);
    expect(skippedReasons.deadline).toBe(5);
    expect(truncated).toBe(true);
    // Deadline is only about START; the five that started all completed.
    expect(images.size + skipped).toBe(10);
  });

  it('never starts a RETRY after the deadline either, and reports the last failure reason', async () => {
    const clock = fakeClock();
    const fetchImpl = fetchSequence(statusResponse(429));
    const { skipped, skippedReasons, truncated } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, ...clock, totalDeadlineMs: 600 },
    );
    // t=0 attempt 1 (429, pause 250) -> t=250 attempt 2 (429, pause 500) ->
    // t=750 >= 600: attempt 3 must not start.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(skipped).toBe(1);
    expect(skippedReasons.rateLimited).toBe(1);
    expect(skippedReasons.deadline).toBe(0);
    expect(truncated).toBe(false);
  });

  it('with no deadline pressure nothing is counted as deadline and truncated stays false', async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(32));
    const { skippedReasons, truncated } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.jpg']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(skippedReasons.deadline).toBe(0);
    expect(truncated).toBe(false);
  });
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function makeWebp(width: number, height = width): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .webp()
    .toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function bytesResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) },
  });
}

describe('fetchExportImageBytes — WebP is decoded server-side (sharp)', () => {
  it('a real WebP thumb comes back as PNG bytes no wider than targetWidth', async () => {
    const webp = await makeWebp(64);
    expect(webp.subarray(0, 4)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46])); // RIFF
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'image/webp'));
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, targetWidth: 16 },
    );
    expect(skipped).toBe(0);
    const image = images.get('a')!;
    expect(image.extension).toBe('png');
    expect([...image.data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const dims = readImageDimensions(image.data)!;
    expect(dims).not.toBeNull();
    expect(dims.width).toBeLessThanOrEqual(16);
    expect(dims.height).toBeLessThanOrEqual(16);
  });

  it('a landscape WebP fits INSIDE the square box, aspect preserved (64x32 into 16 -> 16x8)', async () => {
    const webp = await makeWebp(64, 32);
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'image/webp'));
    const { images } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, targetWidth: 16 },
    );
    expect(readImageDimensions(images.get('a')!.data)).toEqual({ width: 16, height: 8 });
  });

  it('a WebP already smaller than targetWidth is not enlarged (8x8 stays 8x8)', async () => {
    const webp = await makeWebp(8);
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'image/webp'));
    const { images } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, targetWidth: 200 },
    );
    const dims = readImageDimensions(images.get('a')!.data)!;
    expect(dims).toEqual({ width: 8, height: 8 });
  });

  it('forwards targetWidth to the decoder seam (default 200)', async () => {
    const webp = await makeWebp(8);
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'image/webp'));
    const decodeWebp = vi.fn(
      async (_bytes: Uint8Array, _targetWidth: number): Promise<EmbeddedImage | null> => ({
        data: new Uint8Array(PNG_SIGNATURE),
        extension: 'png',
      }),
    );
    await fetchExportImageBytes(new Map([['a', 'https://signed.example/a.webp']]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      decodeWebp,
      targetWidth: 320,
    });
    expect(decodeWebp).toHaveBeenCalledTimes(1);
    expect(decodeWebp.mock.calls[0]![1]).toBe(320);
    await fetchExportImageBytes(new Map([['a', 'https://signed.example/a.webp']]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      decodeWebp,
    });
    expect(decodeWebp.mock.calls[1]![1]).toBe(200);
  });

  it('a decoder that returns null: skipped as unsupported, no retry, batch continues', async () => {
    const webp = await makeWebp(8);
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('.webp') ? bytesResponse(webp, 'image/webp') : jpegResponse(64),
    );
    const decodeWebp = vi.fn(async () => null);
    const { images, skipped, skippedReasons } = await fetchExportImageBytes(
      new Map([
        ['a', 'https://signed.example/a.webp'],
        ['b', 'https://signed.example/b.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, decodeWebp },
    );
    expect(images.has('a')).toBe(false);
    expect(images.has('b')).toBe(true);
    expect(skipped).toBe(1);
    expect(skippedReasons.unsupported).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a decoder that THROWS is treated exactly like one that returns null', async () => {
    const webp = await makeWebp(8);
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'image/webp'));
    const { skipped, skippedReasons } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        decodeWebp: async () => {
          throw new Error('sharp exploded');
        },
      },
    );
    expect(skipped).toBe(1);
    expect(skippedReasons.unsupported).toBe(1);
  });

  it('magic wins over the header: WebP bytes under application/octet-stream still decode', async () => {
    const webp = await makeWebp(8);
    const fetchImpl = vi.fn(async () => bytesResponse(webp, 'application/octet-stream'));
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.bin']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(skipped).toBe(0);
    expect(images.get('a')!.extension).toBe('png');
    expect([...images.get('a')!.data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('magic wins over the header: PNG bytes under image/webp pass through UNTOUCHED', async () => {
    const png = new Uint8Array(64);
    png.set(PNG_SIGNATURE);
    png[20] = 0x42;
    const fetchImpl = vi.fn(async () => bytesResponse(png, 'image/webp'));
    const decodeWebp = vi.fn(async () => null);
    const { images, skipped } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, decodeWebp },
    );
    expect(skipped).toBe(0);
    expect(decodeWebp).not.toHaveBeenCalled();
    expect(images.get('a')!.extension).toBe('png');
    expect(images.get('a')!.data).toEqual(png);
  });

  it('JPEG bytes under image/webp pass through untouched as jpeg', async () => {
    const jpg = new Uint8Array(64);
    jpg.set([0xff, 0xd8, 0xff, 0xe0]);
    const fetchImpl = vi.fn(async () => bytesResponse(jpg, 'image/webp'));
    const decodeWebp = vi.fn(async () => null);
    const { images } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.webp']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, decodeWebp },
    );
    expect(decodeWebp).not.toHaveBeenCalled();
    expect(images.get('a')!.extension).toBe('jpeg');
    expect(images.get('a')!.data).toEqual(jpg);
  });

  it('octet-stream bytes with no recognisable magic are unsupported, not guessed', async () => {
    const fetchImpl = vi.fn(async () => bytesResponse(new Uint8Array(64), 'application/octet-stream'));
    const decodeWebp = vi.fn(async () => null);
    const { skipped, skippedReasons } = await fetchExportImageBytes(
      new Map([['a', 'https://signed.example/a.bin']]),
      { fetchImpl: fetchImpl as unknown as typeof fetch, decodeWebp },
    );
    expect(skipped).toBe(1);
    expect(skippedReasons.unsupported).toBe(1);
    expect(decodeWebp).not.toHaveBeenCalled();
  });
});

describe('webpToPng (default decoder)', () => {
  it('returns null, never throws, for bytes sharp cannot decode', async () => {
    await expect(webpToPng(new Uint8Array([1, 2, 3, 4]), 200)).resolves.toBeNull();
    await expect(webpToPng(new Uint8Array(0), 200)).resolves.toBeNull();
  });

  it('decodes a real WebP to PNG within the box', async () => {
    const out = await webpToPng(await makeWebp(40), 10);
    expect(out).not.toBeNull();
    expect(out!.extension).toBe('png');
    expect(readImageDimensions(out!.data)).toEqual({ width: 10, height: 10 });
  });
});
