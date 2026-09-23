import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every item_images read batches its item ids.
 *
 * The catalog thumbnails pass up to 500 ids, exports and the reports PDF up to
 * 1000. One `.in()` past ~215 uuids answers 414 locally and fails as "fetch
 * failed" in production after ~7 s of retries, so a DC4-sized catalog lost
 * every photo. Batching keeps the primary-first pick: all of one item's rows
 * sit in one batch.
 */

const { createSignedUrlMock, createSignedUrlsMock, reportError } = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
  reportError: vi.fn(async (_err: unknown, _context: unknown) => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: createSignedUrlMock,
        createSignedUrls: createSignedUrlsMock,
      }),
    },
  }),
}));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ServiceError, type ServiceContext } from './context';
import { ItemImagesService } from './item-images';

const ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
// A distinct prefix per test keeps the module's in-process signing memo from
// answering one test with another's URL.
const itemId = (p: string, i: number) =>
  `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function idsOf(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

/** Two images per item, primary first (the order the query asks for). */
function imageTable(opts: { failBatch?: number; withImages?: (id: string) => boolean } = {}) {
  const lists: string[][] = [];
  const fn = (call: MockCall) => {
    const list = idsOf(call, 'item_id');
    lists.push(list);
    if (opts.failBatch === lists.length) return { data: null, error: { message: 'URI too long' } };
    const rows = list
      .filter((id) => opts.withImages?.(id) ?? true)
      .flatMap((id) => [
        {
          item_id: id,
          storage_path: `${ORG}/${id}/primary.webp`,
          thumb_path: `${ORG}/${id}/t.webp`,
          lqip: null,
          is_primary: true,
          sort_order: 1,
        },
        {
          item_id: id,
          storage_path: `${ORG}/${id}/other.webp`,
          thumb_path: null,
          lqip: null,
          is_primary: false,
          sort_order: 0,
        },
      ]);
    return { data: rows, error: null };
  };
  return { fn, lists };
}

function service(client: unknown) {
  return new ItemImagesService(
    makeServiceContext(client, { organizationId: ORG }) as unknown as ServiceContext,
  );
}

beforeEach(() => {
  reportError.mockClear();
  createSignedUrlMock.mockReset();
  createSignedUrlsMock.mockReset();
  createSignedUrlMock.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://signed/${path}` },
    error: null,
  }));
  createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}`, error: null })),
    error: null,
  }));
});

describe('ItemImagesService batched reads', () => {
  it('primaryMasterUrlsForItems reads 250 items in batches of 100 and still picks the primary in batch 3', async () => {
    const t = imageTable();
    const stub = makeSupabaseStub({ 'item_images.select': t.fn });
    const ids = Array.from({ length: 250 }, (_, i) => itemId('a', i));
    const map = await service(stub.client).primaryMasterUrlsForItems(ids);
    expect(t.lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(map.size).toBe(250);
    expect(map.get(itemId('a', 245))).toBe(
      `https://signed/${ORG}/${itemId('a', 245)}/primary.webp`,
    );
    // No custom_fields fallback needed: every item resolved.
    expect(stub.fromCalls).not.toContain('inventory_items');
  });

  it('orders each batch by is_primary, sort_order and then id so pages are stable', async () => {
    const t = imageTable();
    const stub = makeSupabaseStub({ 'item_images.select': t.fn });
    await service(stub.client).primaryImagesForItems([itemId('b', 1)]);
    const chain = stub.chainsAll.get('item_images.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('item_images.select')?.[0] ?? [];
    const orders = chain.map((m, i) => [m, args[i]?.[0]]).filter(([m]) => m === 'order');
    expect(orders.map(([, col]) => col)).toEqual(['is_primary', 'sort_order', 'id']);
    expect(chain).toContain('range');
  });

  it('primaryImagesWithThumbsForItems and primaryImagesForBrowserDisplay batch the same way', async () => {
    const t1 = imageTable();
    const s1 = makeSupabaseStub({ 'item_images.select': t1.fn });
    const ids1 = Array.from({ length: 250 }, (_, i) => itemId('c', i));
    const thumbs = await service(s1.client).primaryImagesWithThumbsForItems(ids1);
    expect(t1.lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(thumbs.get(itemId('c', 249))?.thumbUrl).toBe(
      `https://signed/${ORG}/${itemId('c', 249)}/t.webp`,
    );

    const t2 = imageTable();
    const s2 = makeSupabaseStub({ 'item_images.select': t2.fn });
    const ids2 = Array.from({ length: 250 }, (_, i) => itemId('d', i));
    const browser = await service(s2.client).primaryImagesForBrowserDisplay(ids2);
    expect(t2.lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(browser.size).toBe(250);
  });

  it('the custom_fields cover fallback is batched too', async () => {
    const coverLists: string[][] = [];
    const stub = makeSupabaseStub({
      'item_images.select': imageTable({ withImages: () => false }).fn,
      'inventory_items.select': (call) => {
        const list = idsOf(call, 'id');
        coverLists.push(list);
        return {
          data: list.map((id) => ({
            id,
            custom_fields: { thumbnail_url: `https://covers/${id}` },
          })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => itemId('e', i));
    const map = await service(stub.client).primaryImagesForPdfRendering(ids);
    expect(coverLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(map.get(itemId('e', 249))).toBe(`https://covers/${itemId('e', 249)}`);
  });

  it('throws when any batch fails, never a silently photo-less answer', async () => {
    const t = imageTable({ failBatch: 3 });
    const stub = makeSupabaseStub({ 'item_images.select': t.fn });
    const ids = Array.from({ length: 250 }, (_, i) => itemId('f', i));
    await expect(service(stub.client).primaryMasterUrlsForItems(ids)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
});

/**
 * Signing a COLD cache. A signer used to start one storage request per path,
 * all at once: a cold lab run returned 244 of 356 catalog thumbnails and the
 * route still answered 200 with nothing reported. Storage requests now wait
 * for one of STORAGE_SIGN_CONCURRENCY slots, the catalog masters go through
 * one batched createSignedUrls, and a failed sign is reported with a count.
 */
describe('ItemImagesService signing on a cold cache', () => {
  /** A createSignedUrl that takes a moment, tracks the peak in flight, and
   *  fails for the paths `fails` picks. */
  function slowSigner(fails: (path: string) => boolean = () => false) {
    const state = { inFlight: 0, peak: 0 };
    createSignedUrlMock.mockImplementation(async (path: string) => {
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      state.inFlight -= 1;
      return fails(path)
        ? { data: null, error: { message: 'Bad Gateway' } }
        : { data: { signedUrl: `https://signed/${path}` }, error: null };
    });
    return state;
  }
  const lost = (id: string) => Number(id.slice(-12)) % 10 === 0;

  it('catalog masters: one batched createSignedUrls for 356 cold paths, no per-path storm', async () => {
    const stub = makeSupabaseStub({ 'item_images.select': imageTable().fn });
    const ids = Array.from({ length: 356 }, (_, i) => itemId('1', i));
    const map = await service(stub.client).primaryMasterUrlsForItems(ids);
    expect(map.size).toBe(356);
    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect((createSignedUrlsMock.mock.calls[0]![0] as string[]).length).toBe(356);
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('when the batch fails, the per-path fallback keeps at most 20 in flight and reports what it lost', async () => {
    createSignedUrlsMock.mockRejectedValue(new TypeError('fetch failed'));
    const signer = slowSigner((path) => lost(path.split('/')[1]!));
    const stub = makeSupabaseStub({
      'item_images.select': imageTable().fn,
      // The custom_fields cover fallback finds nothing for the lost ones.
      'inventory_items.select': { data: [], error: null },
    });
    const ids = Array.from({ length: 300 }, (_, i) => itemId('2', i));

    const map = await service(stub.client).primaryMasterUrlsForItems(ids);

    expect(createSignedUrlMock).toHaveBeenCalledTimes(300);
    expect(signer.peak).toBe(20);
    expect(map.size).toBe(270);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'item_images.sign_failed',
      level: 'warning',
      extra: { method: 'signedUrls', requested: 300, failed: 30 },
    });
  });

  it('exports: per-item signing keeps at most 20 in flight and reports the items left without a photo', async () => {
    const signer = slowSigner((path) => lost(path.split('/')[1]!));
    const stub = makeSupabaseStub({
      'item_images.select': imageTable().fn,
      'inventory_items.select': { data: [], error: null },
    });
    const ids = Array.from({ length: 300 }, (_, i) => itemId('3', i));

    const map = await service(stub.client).primaryImagesForServerDecoding(ids);

    expect(signer.peak).toBe(20);
    expect(map.size).toBe(270);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tag: 'item_images.sign_failed',
      extra: { method: 'primaryImagesForServerDecoding', requested: 300, failed: 30 },
    });
  });

  it('PDF transforms wait for a slot too: at most 20 in flight', async () => {
    const signer = slowSigner();
    const stub = makeSupabaseStub({ 'item_images.select': imageTable().fn });
    const ids = Array.from({ length: 60 }, (_, i) => itemId('5', i));

    const map = await service(stub.client).primaryImagesForPdfRendering(ids);

    expect(map.size).toBe(60);
    expect(createSignedUrlMock.mock.calls.every((c) => c[2]?.transform)).toBe(true);
    expect(signer.peak).toBe(20);
  });

  it('a failed transform rescued by the next leg is not reported as a lost photo', async () => {
    createSignedUrlMock.mockImplementation(
      async (path: string, _ttl: number, opts?: { transform?: unknown }) =>
        opts?.transform
          ? { data: null, error: { message: 'rate limited' } }
          : { data: { signedUrl: `https://signed/${path}` }, error: null },
    );
    const stub = makeSupabaseStub({ 'item_images.select': imageTable().fn });
    const ids = Array.from({ length: 5 }, (_, i) => itemId('4', i));

    const map = await service(stub.client).primaryImagesForPdfRendering(ids);

    expect(map.size).toBe(5);
    expect(reportError).not.toHaveBeenCalled();
  });
});
