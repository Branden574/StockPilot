import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public request page's photo pages (B32, integrator decisions 1 to 3).
 *
 * The route is anonymous: a request link token in the query is all it asks.
 * It used to sign a photo for every eligible item of the link on each request
 * (to the catalog's ceiling), and any extra query parameter made a new CDN
 * cache key, so that work could be repeated at will. It now answers one page
 * of at most 500 items, in item_id order (the order the page's catalog is read
 * in), with the URL of the next page, and only for the one URL that names that
 * page: every other spelling is refused before any read. Each page carries the
 * lazy fields of its items (blur placeholder, public description), so the
 * cached catalog stays small.
 *
 * A failed read is not an empty catalog: it answers 500 with no-store, so no
 * cache keeps it, and the page's hook retries. A legacy organization token (no
 * links row) shows an EMPTY catalog on the page, so there is nothing to sign.
 */

const { adminRef, signed, reportError } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  signed: {
    calls: [] as string[][],
    url: (path: string) => `https://signed.test/${path}`,
  },
  reportError: vi.fn(async () => {}),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    async signedUrls(paths: string[]) {
      signed.calls.push(paths);
      return new Map(paths.map((p) => [p, signed.url(p)]));
    }
    // The signer before this change, so the same tests can run against it.
    async primaryMasterUrlsForItems(ids: string[]) {
      signed.calls.push(ids);
      return new Map(ids.map((id) => [id, signed.url(id)]));
    }
  },
}));

import {
  publicPhotoPageUrl,
  type PublicPhotoPage,
} from '@/components/orders/public-v2/photo-pages';
import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { GET } from './route';

const ORG = 'org-1';
const WAREHOUSE = 'abcdef12-3456-4789-8abc-def012345678';
const TOKEN = '0123456789abcdef'.repeat(4);
const CDN = 'public, s-maxage=60, stale-while-revalidate=300';
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const pathOf = (i: number) => `${ORG}/${uuid(i)}/photo.webp`;

function get(pathAndQuery: string) {
  return GET(new NextRequest(`https://test.local${pathAndQuery}`));
}
const page = (n: number) => get(publicPhotoPageUrl(TOKEN, WAREHOUSE, n));
const body = async (res: Response) => (await res.json()) as PublicPhotoPage;

interface Fixture {
  /** Eligible items 0..n-1, each with one photo unless listed below. */
  eligible?: number;
  link?: 'open' | 'closed' | 'none';
  covers?: Record<number, string>;
  descriptions?: Record<number, string>;
  noPhoto?: number[];
  /** item -> another item whose photo path it shares */
  sharesPhotoWith?: Record<number, number>;
  lqip?: (i: number) => string;
  failRpc?: boolean;
  failImages?: boolean;
}

function wire(f: Fixture) {
  const n = f.eligible ?? 0;
  const ids = Array.from({ length: n }, (_, i) => uuid(i));
  const link = f.link ?? 'open';
  const rpcCalls: MockCall[] = [];
  const images = ids.flatMap((id, i) =>
    f.noPhoto?.includes(i)
      ? []
      : [
          {
            id: `img-${String(i).padStart(6, '0')}`,
            organization_id: ORG,
            item_id: id,
            storage_path: pathOf(f.sharesPhotoWith?.[i] ?? i),
            lqip: f.lqip ? f.lqip(i) : `data:image/webp;base64,${i}`,
            is_primary: true,
            sort_order: 0,
          },
        ],
  );
  const items = ids.map((id, i) => ({
    id,
    organization_id: ORG,
    public_description: f.descriptions?.[i] ?? null,
    thumbnail_url: f.covers?.[i] ?? null,
  }));
  const eligible = servedLikePostgrest(ids.map((item_id) => ({ item_id, max_qty: null })));
  const stub = makeSupabaseStub({
    'public_request_links.select': {
      data:
        link === 'none'
          ? null
          : {
              id: 'link-1',
              organization_id: ORG,
              active: link === 'open',
              expires_at: null,
              available_from: null,
              available_until: null,
            },
      error: null,
    },
    'organization_modules.select': { data: { module_id: 'public_requests' }, error: null },
    'warehouses.select': { data: { id: WAREHOUSE }, error: null },
    'rpc:public_link_eligible_items': (call) => {
      // A chained rpc is answered once at call time and again with its chain
      // (supabase-mock.ts makeRpcChain): record the read the code awaited.
      if (call.methods.length > 1) rpcCalls.push(call);
      return f.failRpc ? { data: null, error: { message: 'fetch failed' } } : eligible(call);
    },
    'item_images.select': f.failImages
      ? { data: null, error: { message: 'fetch failed' } }
      : servedLikePostgrest(images),
    'inventory_items.select': servedLikePostgrest(items),
  });
  adminRef.current = stub.client;
  return { ids, stub, rpcCalls };
}

const signedCount = () => signed.calls.reduce((n, c) => n + c.length, 0);

beforeEach(() => {
  signed.calls = [];
  signed.url = (path) => `https://signed.test/${path}`;
  reportError.mockClear();
});

describe('only the one URL of a page does any work (decision 2)', () => {
  const base = `/api/v1/public/catalog-thumbnails?token=${TOKEN}&warehouseId=${WAREHOUSE}`;

  // Mutation caught: any parameter the route ignores, a page=0 or a reordered
  // query answered like the canonical one (each would be a CDN key of its own).
  it.each([
    ['an unknown parameter', `${base}&v=2`],
    [
      'a cache-busting parameter first',
      `/api/v1/public/catalog-thumbnails?x=1&token=${TOKEN}&warehouseId=${WAREHOUSE}`,
    ],
    [
      'the parameters in another order',
      `/api/v1/public/catalog-thumbnails?warehouseId=${WAREHOUSE}&token=${TOKEN}`,
    ],
    ['page=0 (the first page has no page parameter)', `${base}&page=0`],
    ['a page past the last one', `${base}&page=4`],
    ['a page written another way', `${base}&page=01`],
    ['the page given twice', `${base}&page=1&page=2`],
    [
      'an encoded character in the token',
      `/api/v1/public/catalog-thumbnails?token=%30${TOKEN.slice(1)}&warehouseId=${WAREHOUSE}`,
    ],
    [
      'an upper-case warehouse id',
      `/api/v1/public/catalog-thumbnails?token=${TOKEN}&warehouseId=${WAREHOUSE.toUpperCase()}`,
    ],
    ['no warehouse', `/api/v1/public/catalog-thumbnails?token=${TOKEN}`],
    ['no token', `/api/v1/public/catalog-thumbnails?warehouseId=${WAREHOUSE}`],
    [
      'a token shorter than the page accepts',
      `/api/v1/public/catalog-thumbnails?token=short&warehouseId=${WAREHOUSE}`,
    ],
    ['a trailing ampersand', `${base}&`],
  ])('%s: 400, no-store, before any read or signing', async (_what, url) => {
    const { stub } = wire({ eligible: 3 });
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
    expect(signed.calls).toEqual([]);
  });

  it('the first page and each later page are answered, cached at the CDN', async () => {
    wire({ eligible: 3 });
    const first = await page(0);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(CDN);
    for (const n of [1, 2, 3]) expect((await page(n)).status).toBe(200);
  });
});

describe('at most 500 signed photos per request (decision 1)', () => {
  // Mutation caught: the first fix's route, which signed every eligible item
  // (to the 10,000 ceiling) in one request.
  it('2,000 eligible items: the first page signs the first 500 by item id and names the next page', async () => {
    const { ids } = wire({ eligible: 2000 });
    const res = await body(await page(0));
    expect(signedCount()).toBe(500);
    expect(Object.keys(res.urls)).toEqual(ids.slice(0, 500));
    expect(res.next).toBe(publicPhotoPageUrl(TOKEN, WAREHOUSE, 1));
  });

  it('the pages after it sign the next 500 each, in item id order, and the last names none', async () => {
    const { ids, rpcCalls } = wire({ eligible: 2000 });
    const seen: string[] = [];
    for (const n of [0, 1, 2, 3]) {
      signed.calls = [];
      const res = await body(await page(n));
      expect(signedCount()).toBe(500);
      seen.push(...Object.keys(res.urls));
      expect(res.next).toBe(n < 3 ? publicPhotoPageUrl(TOKEN, WAREHOUSE, n + 1) : null);
    }
    // Every item once, none twice: the page's whole catalog.
    expect(seen).toEqual(ids);
    // One eligibility read per page: its own window and one row more.
    expect(rpcCalls.map((c) => callArgs(c, 'range'))).toEqual([
      [0, 500],
      [500, 1000],
      [1000, 1500],
      [1500, 2000],
    ]);
    for (const call of rpcCalls) {
      expect(callArgs(call, 'order')).toEqual(['item_id', { ascending: true }]);
    }
  });

  it('2,001 eligible items: the photo pages stop where the catalog does (2,000 items)', async () => {
    const { ids } = wire({ eligible: 2001 });
    const last = await body(await page(3));
    expect(last.next).toBeNull();
    expect(Object.keys(last.urls)).not.toContain(ids[2000]);
  });

  it('a link of 3 items is one page with no next', async () => {
    const { ids } = wire({ eligible: 3 });
    const res = await body(await page(0));
    expect(Object.keys(res.urls)).toEqual(ids);
    expect(res.next).toBeNull();
  });

  // Decision 8: a bounded number of reads per request.
  it('a full page reads the database 14 times at most: link, module, warehouse, one eligibility page, and 5 + 5 batches', async () => {
    const { stub } = wire({ eligible: 2000 });
    await page(1);
    const count = (t: string) => stub.fromCalls.filter((c) => c === t).length;
    expect(stub.rpcCalls).toHaveLength(1);
    expect(count('public_request_links')).toBe(1);
    expect(count('organization_modules')).toBe(1);
    expect(count('warehouses')).toBe(1);
    expect(count('item_images')).toBe(5);
    expect(count('inventory_items')).toBe(5);
    expect(stub.fromCalls).toHaveLength(13);
  });
});

describe('what a page carries for each item', () => {
  it('a photo is signed and sent with its blur, a cover is sent as it is (never signed, no blur), and the public description rides along', async () => {
    const cover = 'https://covers.example.test/book-1.jpg';
    const { ids } = wire({
      eligible: 3,
      covers: { 1: cover },
      descriptions: { 0: 'Twelve colours.', 1: 'A novel.' },
      noPhoto: [2],
    });
    const res = await body(await page(0));
    expect(res.urls).toEqual({
      [ids[0]!]: `https://signed.test/${pathOf(0)}`,
      [ids[1]!]: cover,
    });
    expect(res.lqip).toEqual({ [ids[0]!]: 'data:image/webp;base64,0' });
    expect(res.descriptions).toEqual({ [ids[0]!]: 'Twelve colours.', [ids[1]!]: 'A novel.' });
    // Only the photo shown was signed.
    expect(signed.calls).toEqual([[pathOf(0)]]);
  });

  it('a photo two items share is signed once and shown on both', async () => {
    const { ids } = wire({ eligible: 2, sharesPhotoWith: { 1: 0 } });
    const res = await body(await page(0));
    expect(signed.calls).toEqual([[pathOf(0)]]);
    expect(res.urls[ids[1]!]).toBe(`https://signed.test/${pathOf(0)}`);
  });
});

describe('failures, a closed link and the legacy token', () => {
  // Mutation caught: an error answered as an empty map with the CDN header.
  it('a failed eligibility read is a 500 that no cache keeps', async () => {
    wire({ eligible: 3, failRpc: true });
    const res = await page(0);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(signed.calls).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a failed photo read is a 500 that no cache keeps, not a page without photos', async () => {
    wire({ eligible: 3, failImages: true });
    const res = await page(0);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(signed.calls).toEqual([]);
  });

  it('a closed link answers an empty page, as before', async () => {
    const { stub } = wire({ eligible: 3, link: 'closed' });
    const res = await page(0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: {}, lqip: {}, descriptions: {}, next: null });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a legacy organization token signs nothing: its page shows an empty catalog', async () => {
    const { stub } = wire({ eligible: 3, link: 'none' });
    const res = await page(0);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: {}, lqip: {}, descriptions: {}, next: null });
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(signed.calls).toEqual([]);
  });
});

describe('a page fits the response limit at the maximum field lengths', () => {
  /** Vercel answers a function response over 4.5 MB with an error. */
  const RESPONSE_LIMIT_BYTES = 4_500_000;

  // A cover and a blur never both ride for one item (a cover is shown, so the
  // photo's blur is not sent), so each item carries the larger of the two: a
  // signed photo (about 500 characters; 600 here) with a 2,000-character blur
  // (the column's limit, 0122), plus a 2,000-character public description
  // (0261) in a script of 3 bytes a character.
  it('500 items, each with a 2,000-character description of 3-byte characters and a 2,000-character blur: under 4.5 MB', async () => {
    const descriptions = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [i, '\u6587'.repeat(2000)]),
    );
    wire({
      eligible: 500,
      descriptions,
      lqip: (i) => `data:image/webp;base64,${String(i).padStart(2000 - 23, 'A')}`,
    });
    signed.url = () => `https://signed.test/${'s'.repeat(600)}`;
    const text = await (await page(0)).text();
    const parsed = JSON.parse(text) as PublicPhotoPage;
    expect(Object.keys(parsed.urls)).toHaveLength(500);
    expect(Object.values(parsed.lqip).every((b) => b.length === 2000)).toBe(true);
    expect(Object.keys(parsed.descriptions)).toHaveLength(500);
    expect(new TextEncoder().encode(text).length).toBeLessThan(RESPONSE_LIMIT_BYTES);
  });
});
