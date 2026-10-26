import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A request link's public catalog (B32): every eligible item, to a ceiling
 * the data cache can hold, and a page that says so past it.
 *
 * Two silent cuts used to apply. The loader kept the first 500 items by name
 * (CATALOG_LIMIT), so item 501 was neither shown nor searchable on the public
 * page. And the eligibility function was read in one unpaged request, which
 * PostgREST answers with at most 1000 rows (max_rows) in no stated order, so
 * past 1000 eligible items an arbitrary set dropped out. The read is paged in
 * item_id order.
 *
 * The catalog is one entry in Next's data cache (unstable_cache), and Next
 * does not store an entry over 2 MB: it warns, and every page view after that
 * reads the whole catalog from the database again. The first fix raised the
 * ceiling to 10,000 and kept every field, blur placeholders and descriptions
 * included: 27,440,087 by Next's measure at the maximum field lengths (no
 * categories), never cached (integrator decision 3). The cached value is now
 * the compact catalog (catalog-index.ts), at most PUBLIC_CATALOG_ROW_CEILING
 * items, every field capped at its maximum length: 1,425,037 at the ceiling
 * by the measure Next itself applies, under 1.5 MB. The heavy fields come
 * with the photo pages. Past the ceiling the catalog is cut, logged, and the
 * page says so.
 *
 * The cache key is the link id and the warehouse id only, so no request can
 * make a new entry; the loader reads the link's organization and display
 * mode itself.
 *
 * The stub answers like PostgREST (servedLikePostgrest): an unpaged read gets
 * 1000 rows, exactly as production would.
 */

const { adminRef, cacheCalls } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  cacheCalls: [] as Array<{ keyParts: unknown; opts: unknown; args: unknown[] }>,
}));
vi.mock('next/cache', () => ({
  unstable_cache: vi.fn(
    (fn: (...a: unknown[]) => unknown, keyParts: unknown, opts: unknown) =>
      (...args: unknown[]) => {
        cacheCalls.push({ keyParts, opts, args });
        return fn(...args);
      },
  ),
  revalidateTag: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));

import { expandPublicCatalog } from '@/components/orders/public-v2/catalog-index';
import { CATALOG_ROW_CEILING } from '@/server/loaders/orders-new-catalog';
import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import {
  getPublicCatalogForLink,
  PUBLIC_CATALOG_ROW_CEILING,
  readEligibleItems,
} from './public-catalog';

const ORG = 'org-1';
const LINK_ID = 'link-1';
const WH = 'wh-1';
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const catUuid = (i: number) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`;

/**
 * The size Next gives a data cache entry, the one it holds to 2 MB:
 * `JSON.stringify(data).length` of the FETCH entry unstable_cache writes,
 * whose body is the value's own JSON (next/dist/server/lib/incremental-cache,
 * and spec-extension/unstable-cache). Written out here, not imported, so the
 * test measures the value the loader returns the way Next will.
 */
function nextDataCacheEntrySize(value: unknown): number {
  return JSON.stringify({
    kind: 'FETCH',
    data: { headers: {}, body: JSON.stringify(value), status: 200, url: '' },
    revalidate: 60,
  }).length;
}
const UNDER_1_5_MB = 1_500_000;

type Mode = 'exact' | 'bucket' | 'none';
interface ItemFixture {
  id: string;
  organization_id: string;
  name: string;
  public_display_name: string | null;
  quantity_on_hand: number;
  category_id: string | null;
  thumbnail_url: string | null;
}

function item(i: number, over: Partial<ItemFixture> = {}): ItemFixture {
  return {
    id: uuid(i),
    organization_id: ORG,
    name: `Item ${String(i).padStart(5, '0')}`,
    public_display_name: null,
    quantity_on_hand: 3,
    category_id: null,
    thumbnail_url: null,
    ...over,
  };
}

/** A link with these eligible items (each with max_qty), in this mode. */
function wire(
  items: ItemFixture[],
  opts: {
    mode?: Mode;
    maxQty?: number | null;
    categories?: Array<{ id: string; organization_id: string; name: string }>;
    reservations?: Array<Record<string, unknown>>;
  } = {},
) {
  const rpcCalls: MockCall[] = [];
  const eligible = servedLikePostgrest(
    items.map((it) => ({ item_id: it.id, max_qty: opts.maxQty ?? null })),
  );
  const stub = makeSupabaseStub({
    'public_request_links.select': {
      data: { organization_id: ORG, availability_display: opts.mode ?? 'exact' },
      error: null,
    },
    'rpc:public_link_eligible_items': (call) => {
      // The stub also answers a chained rpc once at call time, before its
      // chain exists (supabase-mock.ts makeRpcChain): record only the read
      // the code awaited, which carries its order and range.
      if (call.methods.length > 1) rpcCalls.push(call);
      return eligible(call);
    },
    'inventory_items.select': servedLikePostgrest(
      items as unknown as Array<Record<string, unknown>>,
    ),
    'stock_reservations.select': servedLikePostgrest(opts.reservations ?? []),
    'categories.select': servedLikePostgrest(opts.categories ?? []),
  });
  adminRef.current = stub.client;
  return { stub, rpcCalls };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => item(i));

beforeEach(() => {
  vi.restoreAllMocks();
  cacheCalls.length = 0;
});

describe('getPublicCatalogForLink: no silent cut at 500 or 1000 items', () => {
  it('500 eligible items: all 500', async () => {
    wire(many(500));
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(500);
    expect(index.cut).toBe(false);
  });

  // Mutation caught: the old `items.slice(0, 500)`.
  it('501 eligible items: all 501, the last one by name included', async () => {
    wire(many(501));
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(501);
    expect(index.rows.at(-1)?.[0]).toBe(uuid(500));
  });

  it('1000 eligible items: all 1000, in one eligibility page and the check for more', async () => {
    const { rpcCalls } = wire(many(1000));
    expect((await getPublicCatalogForLink(LINK_ID, WH)).rows).toHaveLength(1000);
    expect(rpcCalls.map((c) => callArgs(c, 'range'))).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  // Mutation caught: the unpaged rpc read, which PostgREST cuts at 1000 rows.
  it('1001 eligible items: all 1001, read in item_id order across two pages', async () => {
    const { rpcCalls } = wire(many(1001));
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(new Set(index.rows.map((r) => r[0]))).toEqual(new Set(many(1001).map((i) => i.id)));
    expect(rpcCalls).toHaveLength(2);
    for (const call of rpcCalls) {
      expect(callArgs(call, 'order')).toEqual(['item_id', { ascending: true }]);
    }
  });
});

describe('the ceiling', () => {
  // Decision 3: the value must be cacheable at the ceiling. 10,000 items at
  // the maximum field lengths cannot be (see the size test below), so the
  // public ceiling is lower than the internal storefront's.
  it('is 2,000 items, below the internal storefront’s 10,000', () => {
    expect(PUBLIC_CATALOG_ROW_CEILING).toBe(2000);
    expect(PUBLIC_CATALOG_ROW_CEILING).toBeLessThan(CATALOG_ROW_CEILING);
  });

  it('2,000 eligible items: all 2,000, not cut, no log, in three reads', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rpcCalls } = wire(many(2000));
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(2000);
    expect(index.cut).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(rpcCalls.map((c) => callArgs(c, 'range'))).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2000],
    ]);
  });

  // Mutation caught: a cut that is not said (cut false), or one at the wrong
  // place.
  it('2,001 eligible items: the first 2,000 by item_id, cut, and logged once', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    wire(many(2001));
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(2000);
    expect(index.cut).toBe(true);
    expect(index.rows.map((r) => r[0])).not.toContain(uuid(2000));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/link link-1 .*more than 2000 eligible items/);
  });

  it('readEligibleItems stops at the ceiling it is given and says whether it cut', async () => {
    wire(many(7));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cut = await readEligibleItems(adminRef.current as never, LINK_ID, WH, { ceiling: 5 });
    expect(cut.items.map((r) => r.item_id)).toEqual([0, 1, 2, 3, 4].map(uuid));
    expect(cut.cut).toBe(true);

    wire(many(5));
    const whole = await readEligibleItems(adminRef.current as never, LINK_ID, WH, { ceiling: 5 });
    expect(whole.items).toHaveLength(5);
    expect(whole.cut).toBe(false);
  });

  it('a failed page fails the read (never the rows before it as the whole catalog)', async () => {
    const stub = makeSupabaseStub({
      'rpc:public_link_eligible_items': (call) =>
        (callArgs(call, 'range')?.[0] as number) === 0
          ? {
              data: Array.from({ length: 1000 }, (_, i) => ({ item_id: uuid(i), max_qty: null })),
              error: null,
            }
          : { data: null, error: { message: 'fetch failed' } },
    });
    await expect(readEligibleItems(stub.client, LINK_ID, WH)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('the cached value fits the data cache at the ceiling', () => {
  /** Ceiling + 1 eligible items, every field at its maximum: a 300-character
   *  public display name (its database limit), each item in its own category
   *  with a 120-character label (the category form's limit), 10-digit
   *  quantities with 4 decimals, the largest per-request limit, and a cover
   *  URL as long as a row keeps. */
  function atMaximumLengths(nameChar: string, labelChar: string) {
    const n = PUBLIC_CATALOG_ROW_CEILING + 1;
    const items = Array.from({ length: n }, (_, i) =>
      item(i, {
        name: nameChar.repeat(400),
        public_display_name: nameChar.repeat(300),
        quantity_on_hand: 9_999_999_999.9999,
        category_id: catUuid(i),
        thumbnail_url: `https://covers.example.test/${'c'.repeat(160 - 28)}`,
      }),
    );
    const categories = items.map((_, i) => ({
      id: catUuid(i),
      organization_id: ORG,
      name: labelChar.repeat(200),
    }));
    return { items, categories };
  }

  // Mutation caught: the first fix's value (10,000 items with blur
  // placeholders and descriptions, 27,440,087 by this measure; see the top of
  // the file), any field left uncapped, or a ceiling raised past what fits.
  it('ceiling-many items at the maximum field lengths: under 1.5 MB by Next’s own measure', async () => {
    const { items, categories } = atMaximumLengths('N', 'C');
    wire(items, { maxQty: 2_147_483_647, categories });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(PUBLIC_CATALOG_ROW_CEILING);
    expect(index.cut).toBe(true);
    // Every field is there at full length: nothing was dropped to fit.
    expect(index.rows[0]?.[1]).toHaveLength(300);
    expect(index.categories[0]?.[1]).toHaveLength(120);
    expect(index.rows[0]?.[5]).toHaveLength(160);
    expect(index.rows[0]?.[3]).toBe(9_999_999_999.9999);
    expect(index.rows[0]?.[4]).toBe(2_147_483_647);
    expect(nextDataCacheEntrySize(index)).toBeLessThan(UNDER_1_5_MB);
  });

  // Characters that grow in JSON: a quote or backslash takes 2 characters in
  // the value's JSON and 4 once Next encodes that JSON again, a control
  // character 7, an emoji 2 from the start. The caps count the encoded
  // length, so no name can push the value past the limit.
  it.each([
    ['quotes', '"', '\\'],
    ['control characters', '\u0001', '\u0002'],
    ['emoji', '\u{1F4E6}', '\u{1F4DA}'],
  ])('names and labels made of %s: still under 1.5 MB', async (_what, nameChar, labelChar) => {
    const { items, categories } = atMaximumLengths(nameChar, labelChar);
    wire(items, { maxQty: 2_147_483_647, categories });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows).toHaveLength(PUBLIC_CATALOG_ROW_CEILING);
    expect(nextDataCacheEntrySize(index)).toBeLessThan(UNDER_1_5_MB);
    // A cut never splits an emoji into half a character.
    expect(index.rows[0]?.[1]).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('a cover URL longer than a row keeps is left to the photo pages, not cut', async () => {
    wire([
      item(0, { thumbnail_url: `https://covers.example.test/${'c'.repeat(200)}` }),
      item(1, { thumbnail_url: 'https://covers.example.test/short.jpg' }),
      item(2, { thumbnail_url: 'javascript:alert(1)' }),
    ]);
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows.map((r) => r[5])).toEqual([
      null,
      'https://covers.example.test/short.jpg',
      null,
    ]);
  });
});

describe('the cache key is the link and the warehouse only', () => {
  // Note on decision 3: no query parameter, header or link field can make a
  // new entry or force a load past the cache.
  it('the cached loader is keyed by (link id, warehouse id), tagged with the link', async () => {
    wire(many(2));
    await getPublicCatalogForLink(LINK_ID, WH);
    expect(cacheCalls).toEqual([
      {
        keyParts: ['public-link-catalog-v2'],
        opts: { revalidate: 60, tags: ['public-catalog-link-1'] },
        args: [LINK_ID, WH],
      },
    ]);
  });

  // The mode travels with the rows (catalog-index.ts): the page's own copy
  // of the link is cached apart from this entry, so after a mode change the
  // two could disagree, and a bucket level would read as an exact count.
  it('the loader reads the link’s organization and display mode itself, and the catalog carries the mode', async () => {
    const { stub } = wire([item(0, { quantity_on_hand: 2 })], { mode: 'bucket' });
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    const linkRead = stub.chainArgs.get('public_request_links.select');
    expect(linkRead?.[0]).toEqual(['organization_id, availability_display']);
    expect(linkRead).toContainEqual(['id', LINK_ID]);
    expect(index.mode).toBe('bucket');
    expect(expandPublicCatalog(index)[0]?.availability).toEqual({
      kind: 'bucket',
      level: 'low_stock',
    });
  });

  it('an empty eligible set still carries the link’s mode', async () => {
    wire([], { mode: 'exact' });
    expect(await getPublicCatalogForLink(LINK_ID, WH)).toEqual({
      mode: 'exact',
      categories: [],
      rows: [],
      cut: false,
    });
  });

  it('an unknown link is an empty catalog', async () => {
    const stub = makeSupabaseStub({
      'public_request_links.select': { data: null, error: null },
    });
    adminRef.current = stub.client;
    expect(await getPublicCatalogForLink(LINK_ID, WH)).toEqual({
      mode: 'none',
      categories: [],
      rows: [],
      cut: false,
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a failed link read throws, so nothing is cached', async () => {
    adminRef.current = makeSupabaseStub({
      'public_request_links.select': { data: null, error: { message: 'fetch failed' } },
    }).client;
    await expect(getPublicCatalogForLink(LINK_ID, WH)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('what a row says, by display mode', () => {
  it('exact: the net count, reservations taken off; none: no stock at all and no reservation read', async () => {
    const reservations = [
      { id: 'r1', organization_id: ORG, item_id: uuid(0), quantity: 2, released_at: null },
      { id: 'r2', organization_id: ORG, item_id: uuid(0), quantity: 5, released_at: '2026-01-01' },
    ];
    wire([item(0, { quantity_on_hand: 9 })], { reservations });
    const exact = await getPublicCatalogForLink(LINK_ID, WH);
    expect(exact.rows[0]?.[3]).toBe(7);

    const { stub } = wire([item(0, { quantity_on_hand: 9 })], { reservations, mode: 'none' });
    const none = await getPublicCatalogForLink(LINK_ID, WH);
    expect(none.rows[0]?.[3]).toBeNull();
    expect(stub.fromCalls).not.toContain('stock_reservations');
  });

  it('categories are stored once and named from the category read', async () => {
    wire(
      [
        item(0, { category_id: catUuid(1) }),
        item(1, { category_id: catUuid(1) }),
        item(2, { category_id: null }),
      ],
      { categories: [{ id: catUuid(1), organization_id: ORG, name: 'Novels' }] },
    );
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.categories).toEqual([[catUuid(1), 'Novels']]);
    expect(index.rows.map((r) => r[2])).toEqual([0, 0, -1]);
  });
});

describe('the reservation read is bounded', () => {
  // Reservations decide the availability shown, so a read cut short would
  // show reserved stock as available. Past 10 pages for one batch of 100
  // items the load fails (never cached) instead of reading on.
  it('a batch whose open reservations fill 10 pages fails the load, logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reservations = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r-${String(i).padStart(6, '0')}`,
      organization_id: ORG,
      item_id: uuid(0),
      quantity: 1,
      released_at: null,
    }));
    wire([item(0, { quantity_on_hand: 50_000 })], { reservations });
    await expect(getPublicCatalogForLink(LINK_ID, WH)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/open reservations/);
  });

  it('9,999 open reservations are read in full', async () => {
    const reservations = Array.from({ length: 9_999 }, (_, i) => ({
      id: `r-${String(i).padStart(6, '0')}`,
      organization_id: ORG,
      item_id: uuid(0),
      quantity: 1,
      released_at: null,
    }));
    wire([item(0, { quantity_on_hand: 10_000 })], { reservations });
    const index = await getPublicCatalogForLink(LINK_ID, WH);
    expect(index.rows[0]?.[3]).toBe(1);
  });
});
