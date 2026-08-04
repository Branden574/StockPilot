import { beforeEach, describe, expect, it, vi } from 'vitest';

const primaryImagesForPdfRendering = vi.fn();

vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: vi.fn().mockImplementation(() => ({ primaryImagesForPdfRendering })),
}));

import { ItemImagesService } from '@/server/services/item-images';

import {
  attachExportImages,
  EXPORT_IMAGE_TARGET_WIDTH_PX,
  EXPORT_TOO_MANY_IMAGES_MESSAGE,
  fetchExportImageBytes,
  IMAGE_FETCH_CONCURRENCY,
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_EMBEDDED_IMAGE_BYTES,
  MAX_TOTAL_EMBEDDED_IMAGE_BYTES,
} from './export-images';
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
  // zero calls to primaryImagesForPdfRendering.
  vi.mocked(ItemImagesService).mockImplementation(
    () => ({ primaryImagesForPdfRendering }) as never,
  );
  primaryImagesForPdfRendering.mockReset();
});

describe('attachExportImages', () => {
  it('asks the PDF-sized resolver ONCE for every id, never per row', async () => {
    primaryImagesForPdfRendering.mockResolvedValue(
      new Map([
        ['a', 'https://signed.example/a.webp'],
        ['b', 'https://signed.example/b.webp'],
      ]),
    );
    const rows = [makeRow('a'), makeRow('b'), makeRow('c')];
    await attachExportImages(ctx, rows, { imageSize: 'medium' });
    expect(primaryImagesForPdfRendering).toHaveBeenCalledTimes(1);
    expect(primaryImagesForPdfRendering).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    );
    expect(rows[0]!.image).toEqual({ thumbnailUrl: 'https://signed.example/a.webp' });
    expect(rows[2]!.image).toBeNull();
  });

  it('scales the requested thumbnail width with the chosen image size', async () => {
    primaryImagesForPdfRendering.mockResolvedValue(new Map());
    await attachExportImages(ctx, [makeRow('a')], { imageSize: 'large' });
    expect(primaryImagesForPdfRendering).toHaveBeenCalledWith(['a'], 320);
  });

  it('FAILS CLOSED — a resolver throw leaves every row imageless instead of failing the export', async () => {
    primaryImagesForPdfRendering.mockRejectedValue(new Error('storage unavailable'));
    const rows = [makeRow('a')];
    await expect(attachExportImages(ctx, rows, { imageSize: 'small' })).resolves.toBeUndefined();
    expect(rows[0]!.image).toBeNull();
  });

  it('does nothing at all for an empty row set', async () => {
    await attachExportImages(ctx, [], { imageSize: 'small' });
    expect(primaryImagesForPdfRendering).not.toHaveBeenCalled();
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

  it('skips unsupported content types — SVG and WebP are never embedded', async () => {
    // SVG is a script carrier. WebP is skipped because exceljs accepts only
    // png/jpeg/gif and older Excel cannot decode WebP — a mislabelled WebP
    // renders as a broken picture rather than failing loudly.
    for (const type of ['image/svg+xml', 'image/webp', 'image/gif', 'text/html']) {
      const fetchImpl = vi.fn(async () => jpegResponse(256, type));
      const { images, skipped } = await fetchExportImageBytes(
        new Map([['a', 'https://signed.example/a.bin']]),
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
      expect(images.size, type).toBe(0);
      expect(skipped, type).toBe(1);
    }
  });

  it('skips a non-200 response and a thrown fetch without failing the batch', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('404.jpg')) return new Response('nope', { status: 404 });
      if (url.endsWith('boom.jpg')) throw new Error('ECONNRESET');
      return jpegResponse(128);
    });
    const { images, skipped } = await fetchExportImageBytes(
      new Map([
        ['a', 'https://signed.example/404.jpg'],
        ['b', 'https://signed.example/boom.jpg'],
        ['c', 'https://signed.example/ok.jpg'],
      ]),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(images.size).toBe(1);
    expect(images.has('c')).toBe(true);
    expect(skipped).toBe(2);
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
      { fetchImpl: fetchImpl as unknown as typeof fetch },
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
      await vi.advanceTimersByTimeAsync(IMAGE_FETCH_TIMEOUT_MS);
      const { images, skipped } = await pending;
      expect(images.size).toBe(0);
      expect(skipped).toBe(1);
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
    primaryImagesForPdfRendering.mockResolvedValue(new Map());
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

    expect(primaryImagesForPdfRendering).not.toHaveBeenCalled();
    expect(rows[0]!.image).toBeNull();
    expect(rows[1]!.image).toBeNull();
  });

  it('calls the image resolver exactly ONCE, batched not per-row, when the export selects the Image field', async () => {
    primaryImagesForPdfRendering.mockResolvedValue(
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

    expect(primaryImagesForPdfRendering).toHaveBeenCalledTimes(1);
    expect(primaryImagesForPdfRendering).toHaveBeenCalledWith(
      ['a', 'b', 'c'],
      EXPORT_IMAGE_TARGET_WIDTH_PX.medium,
    );
    for (const row of rows) {
      expect(row.image).not.toBeNull();
    }
  });
});
