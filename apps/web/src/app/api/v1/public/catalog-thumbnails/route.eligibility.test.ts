import { createRequire } from 'node:module';

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
 * page: every other spelling it sees is refused before any read. Each page
 * carries the lazy fields of its items (blur placeholder, public description),
 * so the cached catalog stays small.
 *
 * Every request here is served the way a Next server serves it: Next rewrites
 * the request's URL before the route sees it (normalizeCdnUrl, called by the
 * route module's prepare() on every request), and some spellings of a page's
 * URL come out of that as the page's own URL. The route cannot refuse those,
 * and the CDN keeps each apart, so the costly read of a page (the eligibility
 * window: the function computes the link's whole eligible set) comes from the
 * data cache, keyed by the link, the warehouse and the page (review round 2).
 *
 * A page's size is bounded too: each item's photo or cover URL, blur and
 * description take at most PHOTO_PAGE_ITEM_MAX_BYTES of the answer, so the
 * largest page stays under Vercel's 4.5 MB response limit whatever the text.
 *
 * A failed read is not an empty catalog: it answers 500 with no-store, so no
 * cache keeps it, and the page's hook retries. A legacy organization token (no
 * links row) shows an EMPTY catalog on the page, so there is nothing to sign.
 */

const { adminRef, signed, reportError, dataCache } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  signed: {
    calls: [] as string[][],
    url: (path: string) => `https://signed.test/${path}`,
  },
  reportError: vi.fn(async () => {}),
  dataCache: {
    entries: new Map<string, string>(),
    calls: [] as Array<{ keyParts: unknown; opts: unknown; args: unknown[] }>,
  },
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
// Next's data cache as unstable_cache keys it: the function, its key parts and
// its arguments, nothing from the request
// (next/dist/server/web/spec-extension/unstable-cache.js). A value is kept as
// JSON and read back from it; a thrown error is not kept.
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...a: unknown[]) => Promise<unknown>, keyParts: unknown, opts: unknown) =>
    async (...args: unknown[]) => {
      dataCache.calls.push({ keyParts, opts, args });
      const key = JSON.stringify([String(fn), keyParts, args]);
      const hit = dataCache.entries.get(key);
      if (hit !== undefined) return JSON.parse(hit) as unknown;
      const value = await fn(...args);
      dataCache.entries.set(key, JSON.stringify(value));
      return value;
    },
  revalidateTag: vi.fn(),
}));

import {
  publicPhotoPageUrl,
  type PublicPhotoPage,
} from '@/components/orders/public-v2/photo-pages';
import {
  PHOTO_PAGE_BLUR_MAX_BYTES,
  PHOTO_PAGE_ITEM_MAX_BYTES,
  PHOTO_PAGE_URL_MAX_BYTES,
} from '@/server/services/public-catalog';
import { publicCatalogTag } from '@/server/services/public-links';
import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { GET } from './route';

// Next's own request preparation, as the route module's prepare() runs it on
// every request before the handler sees the request (next start, and the
// minimal mode Vercel runs).
const nextRequire = createRequire(createRequire(import.meta.url).resolve('next/package.json'));
const { normalizeCdnUrl } = nextRequire('./dist/server/server-utils.js') as {
  normalizeCdnUrl: (req: { url: string }, paramKeys: string[]) => void;
};

const ORG = 'org-1';
const LINK = 'link-1';
const WAREHOUSE = 'abcdef12-3456-4789-8abc-def012345678';
const TOKEN = '0123456789abcdef'.repeat(4);
const ROUTE = '/api/v1/public/catalog-thumbnails';
const CDN = 'public, s-maxage=60, stale-while-revalidate=300';
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const pathOf = (i: number) => `${ORG}/${uuid(i)}/photo.webp`;

/** A request for `target` (path and query, as the browser sent it), served
 *  as a Next server serves it: the route sees the URL Next leaves. */
function get(target: string) {
  const req = { url: target };
  normalizeCdnUrl(req, []);
  return GET(new NextRequest(`https://test.local${req.url}`));
}
const page = (n: number) => get(publicPhotoPageUrl(TOKEN, WAREHOUSE, n));
const body = async (res: Response) => (await res.json()) as PublicPhotoPage;

/** Bytes a value adds to a JSON answer, less its quotes. */
const jsonBytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length - 2;

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
              id: LINK,
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
  dataCache.entries.clear();
  dataCache.calls = [];
});

describe('only the one URL of a page does any work (decision 2)', () => {
  const base = `${ROUTE}?token=${TOKEN}&warehouseId=${WAREHOUSE}`;

  // Mutation caught: any parameter the route ignores, a page=0 or a reordered
  // query answered like the canonical one (each would be a CDN key of its own).
  it.each([
    ['an unknown parameter', `${base}&v=2`],
    ['a cache-busting parameter first', `${ROUTE}?x=1&token=${TOKEN}&warehouseId=${WAREHOUSE}`],
    ['the parameters in another order', `${ROUTE}?warehouseId=${WAREHOUSE}&token=${TOKEN}`],
    ['page=0 (the first page has no page parameter)', `${base}&page=0`],
    ['a page past the last one', `${base}&page=4`],
    ['a page written another way', `${base}&page=01`],
    ['the page given twice', `${base}&page=1&page=2`],
    ['the token given twice', `${base}&token=${TOKEN}`],
    [
      'an upper-case warehouse id',
      `${ROUTE}?token=${TOKEN}&warehouseId=${WAREHOUSE.toUpperCase()}`,
    ],
    ['no warehouse', `${ROUTE}?token=${TOKEN}`],
    ['no token', `${ROUTE}?warehouseId=${WAREHOUSE}`],
    ['a token shorter than the page accepts', `${ROUTE}?token=short&warehouseId=${WAREHOUSE}`],
    ['a parameter named nxtP exactly', `${base}&nxtP`],
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

describe("spellings Next rewrites to the page's own URL run no eligibility read of their own (review round 2)", () => {
  const first = `${ROUTE}?token=${TOKEN}&warehouseId=${WAREHOUSE}`;
  const second = `${first}&page=1`;

  // What Next 16 does before the route sees the request: it drops every
  // parameter whose name starts with nxtP or nxtI (and nextInternalLocale),
  // and re-writes the query, which decodes a percent-escape and drops an
  // empty segment. Each spelling is a CDN key of its own, and the route
  // answers each as the page. Pinned here, so a Next upgrade that changes
  // them shows.
  const rewritten: Array<[string, string, string]> = [
    ['a parameter named nxtP...', `${first}&nxtPcachebust=8f3a`, first],
    [
      'a parameter named nxtP... first',
      `${ROUTE}?nxtPa=1&token=${TOKEN}&warehouseId=${WAREHOUSE}`,
      first,
    ],
    ['a parameter named nxtI...', `${first}&nxtIx=1`, first],
    ['nextInternalLocale', `${first}&nextInternalLocale=x`, first],
    ['a page with a parameter named nxtP...', `${second}&nxtPz=9`, second],
    [
      'an encoded character in the token',
      `${ROUTE}?token=%30${TOKEN.slice(1)}&warehouseId=${WAREHOUSE}`,
      first,
    ],
    [
      'an encoded dash in the warehouse id',
      `${ROUTE}?token=${TOKEN}&warehouseId=abcdef12%2D3456-4789-8abc-def012345678`,
      first,
    ],
    ['an encoded page number', `${first}&page=%31`, second],
    ['a trailing ampersand', `${first}&`, first],
    ['five trailing ampersands', `${first}&&&&&`, first],
    ['a leading ampersand', `${ROUTE}?&token=${TOKEN}&warehouseId=${WAREHOUSE}`, first],
    ['a doubled ampersand', `${ROUTE}?token=${TOKEN}&&warehouseId=${WAREHOUSE}`, first],
  ];

  it.each(rewritten)("%s: Next hands the route the page's own URL", (_what, raw, own) => {
    const req = { url: raw };
    normalizeCdnUrl(req, []);
    expect(req.url).toBe(own);
  });

  // Mutation caught: the window read on every request (each spelling then
  // re-runs the function over the link's whole eligible set).
  it('every one of them is answered as its page, and each page reads its eligibility window once between them', async () => {
    const { rpcCalls } = wire({ eligible: 600 });
    const own = new Map<string, string>();
    for (const target of [first, second]) own.set(target, await (await get(target)).text());
    for (const [, raw, target] of rewritten) {
      const res = await get(raw);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(CDN);
      expect(await res.text()).toBe(own.get(target));
    }
    expect(rpcCalls.map((c) => callArgs(c, 'range'))).toEqual([
      [0, 500],
      [500, 1000],
    ]);
  });

  // Mutation caught: as above. The review's probe: 100 values of one such
  // parameter were 100 runs of the function.
  it('100 values of a parameter named nxtP...: one run of the eligibility function', async () => {
    const { rpcCalls } = wire({ eligible: 600 });
    for (let i = 0; i < 100; i += 1) {
      expect((await get(`${first}&nxtPcb=${i}`)).status).toBe(200);
    }
    expect(rpcCalls).toHaveLength(1);
  });
});

describe('the eligibility window comes from the data cache (review round 2)', () => {
  // Mutation caught: a key with anything from the request in it (a new entry
  // per spelling), a key without the page (one page's window answering every
  // page), or no tag (a link or item change would leave the window stale).
  it("keyed by the link id, the warehouse id and the page only, for 60 s, tagged with the link's catalog tag", async () => {
    wire({ eligible: 600 });
    await page(0);
    await page(1);
    expect(dataCache.calls.map((c) => c.args)).toEqual([
      [LINK, WAREHOUSE, 0],
      [LINK, WAREHOUSE, 1],
    ]);
    for (const call of dataCache.calls) {
      expect(call.keyParts).toEqual(['public-link-photo-window-v1']);
      expect(call.opts).toEqual({ revalidate: 60, tags: [publicCatalogTag(LINK)] });
    }
  });

  it('a window read that failed is not kept: the next request reads it again', async () => {
    wire({ eligible: 3, failRpc: true });
    expect((await page(0)).status).toBe(500);
    const { rpcCalls } = wire({ eligible: 3 });
    expect((await page(0)).status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
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

describe('a page stays under the response limit whatever its text (review round 2)', () => {
  /** Vercel answers a function response over 4.5 MB with an error. */
  const RESPONSE_LIMIT_BYTES = 4_500_000;
  /** Each of an item's three entries adds its id key and punctuation:
   *  `"<36-character id>":"<value>",`, 42 bytes besides the value. */
  const ENTRY_OVERHEAD = 42;
  /** The largest page: 500 items at their budget, plus the envelope and a
   *  next URL. */
  const PAGE_MAX = 500 * (PHOTO_PAGE_ITEM_MAX_BYTES + 3 * ENTRY_OVERHEAD) + 300;
  /** A signed URL of 600 bytes (real ones are about 500) and a blur at the
   *  column's 2,000-character limit (0122): the photo item with the least
   *  room left for its description. */
  const signedUrl600 = () => `https://signed.test/${'s'.repeat(580)}`;
  const blur2000 = (i: number) => `data:image/webp;base64,${String(i).padStart(2000 - 23, 'A')}`;
  const ROOM = PHOTO_PAGE_ITEM_MAX_BYTES - 600 - 2000;

  async function measured(f: Fixture) {
    const { ids } = wire(f);
    const text = await (await page(0)).text();
    return {
      ids,
      text,
      bytes: new TextEncoder().encode(text).length,
      parsed: JSON.parse(text) as PublicPhotoPage,
    };
  }

  function itemBytes(p: PublicPhotoPage, id: string): number {
    return [p.urls[id], p.lqip[id], p.descriptions[id]].reduce(
      (n, v) => n + (v === undefined ? 0 : jsonBytes(v)),
      0,
    );
  }

  it('the budgets keep the largest page under 4.5 MB', () => {
    expect(PHOTO_PAGE_URL_MAX_BYTES).toBe(2000);
    expect(PHOTO_PAGE_BLUR_MAX_BYTES).toBe(2000);
    expect(PAGE_MAX).toBeLessThan(RESPONSE_LIMIT_BYTES);
  });

  // Mutation caught: a description sent whole (7,363,048 bytes for this page:
  // JSON writes each control character as 6 bytes), or cut by characters
  // instead of bytes.
  it("500 descriptions of 2,000 control characters, with a 2,000-character blur and a 600-byte URL: each is cut to its item's room, and the page is under 4.5 MB", async () => {
    signed.url = signedUrl600;
    const original = '\u0001'.repeat(2000);
    const { ids, bytes, parsed } = await measured({
      eligible: 500,
      descriptions: Object.fromEntries(ids500().map((i) => [i, original])),
      lqip: blur2000,
    });
    expect(Object.keys(parsed.urls)).toHaveLength(500);
    expect(Object.keys(parsed.lqip)).toHaveLength(500);
    for (const id of ids) {
      expect(parsed.descriptions[id]).toBe('\u0001'.repeat(ROOM / 6));
      expect(itemBytes(parsed, id)).toBeLessThanOrEqual(PHOTO_PAGE_ITEM_MAX_BYTES);
    }
    expect(bytes).toBeLessThanOrEqual(PAGE_MAX);
    expect(bytes).toBeLessThan(RESPONSE_LIMIT_BYTES);
  });

  // Mutation caught: as above (5,363,048 bytes sent whole), or a cut inside
  // a character (a lone surrogate, which JSON writes as 6 bytes and no
  // browser draws).
  it("500 descriptions of 2,000 four-byte characters (the database's 2,000-character limit): cut between characters, and the page is under 4.5 MB", async () => {
    signed.url = signedUrl600;
    const { ids, bytes, parsed } = await measured({
      eligible: 500,
      descriptions: Object.fromEntries(ids500().map((i) => [i, '\u{1F600}'.repeat(2000)])),
      lqip: blur2000,
    });
    for (const id of ids) {
      expect(parsed.descriptions[id]).toBe('\u{1F600}'.repeat(ROOM / 4));
    }
    expect(bytes).toBeLessThan(RESPONSE_LIMIT_BYTES);
  });

  // The text the item form accepts (2,000 characters) is never cut on an item
  // whose photo URL and blur are of a real size.
  it('a 2,000-character description in a 3-byte script, with a real-sized blur and photo URL, is sent whole', async () => {
    const description = '\u6587'.repeat(2000);
    const { ids, parsed } = await measured({
      eligible: 3,
      descriptions: { 0: description, 1: description, 2: description },
      lqip: (i) => `data:image/webp;base64,${String(i).padStart(400, 'A')}`,
    });
    for (const id of ids) expect(parsed.descriptions[id]).toBe(description);
  });

  // Mutation caught: a blur sent whatever its size (JSON writes 2,000 control
  // characters as 12,000 bytes; a real blur is base64).
  it('a blur that passes 2,000 bytes is left out, and reported', async () => {
    const { ids, parsed } = await measured({
      eligible: 2,
      lqip: (i) => (i === 0 ? '\u0001'.repeat(2000) : 'data:image/webp;base64,AAAA'),
    });
    expect(parsed.lqip).toEqual({ [ids[1]!]: 'data:image/webp;base64,AAAA' });
    expect(Object.keys(parsed.urls)).toEqual(ids);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  // Mutation caught: a cover sent whatever its size. A cover is shown instead
  // of the photo, so the item shows its photo when its cover is not usable.
  it('a cover that passes 2,000 bytes is not used: the item shows its photo', async () => {
    const longCover = `https://covers.example.test/${'\u00e9'.repeat(1000)}`;
    const { ids, parsed } = await measured({ eligible: 1, covers: { 0: longCover } });
    expect(longCover.length).toBeLessThan(2000);
    expect(parsed.urls).toEqual({ [ids[0]!]: `https://signed.test/${pathOf(0)}` });
    expect(signed.calls).toEqual([[pathOf(0)]]);
  });

  // Mutation caught: a signed URL sent whatever its size.
  it('a signed URL that passes 2,000 bytes is left out, and reported', async () => {
    signed.url = (path) =>
      path === pathOf(0)
        ? `https://signed.test/${'s'.repeat(2000)}`
        : `https://signed.test/${path}`;
    const { ids, parsed } = await measured({ eligible: 2 });
    expect(Object.keys(parsed.urls)).toEqual([ids[1]!]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

/** Item indexes 0..499. */
function ids500(): number[] {
  return Array.from({ length: 500 }, (_, i) => i);
}
