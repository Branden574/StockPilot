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

const { createSignedUrlMock, createSignedUrlsMock } = vi.hoisted(() => ({
  createSignedUrlMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
}));

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
