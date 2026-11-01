import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

/**
 * WHAT THE NEW RENTAL PAGE ASKS FOR ITS PHOTOS.
 *
 * L4L, 2026-09-25: "rental photos take about 5 seconds to pop up on the new
 * rentals page". The page shows a handful of rental items, and its deferred
 * photo request sent `includeRentals=1`, which only DROPPED this route's
 * is_rental=false filter: the route read every orderable item in the warehouse
 * (up to 500) and resolved a signed photo URL for each one. `rentalsOnly=1`
 * reads exactly the rental items that page lists.
 *
 * The route runs for real here, with the real ItemImagesService; only the
 * database, storage, Next's data cache and the rate limiter are stubbed, and
 * each is COUNTED, so the numbers below are the cost of one page load. The
 * old shapes (no flag, and includeRentals=1) are refused now: nothing sends
 * them, and each one signed a photo for every orderable item in the
 * warehouse.
 */

const {
  apiCtx,
  cacheReads,
  createSignedUrlsMock,
  createSignedUrlMock,
  reportError,
  ceiling,
  checkRateLimit,
} = vi.hoisted(() => ({
  apiCtx: { current: null as unknown },
  cacheReads: { count: 0 },
  createSignedUrlsMock: vi.fn(),
  createSignedUrlMock: vi.fn(),
  reportError: vi.fn(async (_err: unknown, _context: unknown) => undefined),
  // The loader's CATALOG_ROW_CEILING, lowered by the ceiling test.
  ceiling: { value: 10_000 },
  checkRateLimit: vi.fn(
    async (_key: string, _limit: number, _windowMs: number, _mode?: 'open' | 'closed') => ({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    }),
  ),
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn(async () => apiCtx.current) }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
// The route imports only CATALOG_ROW_CEILING from the loader. A getter, so a
// test can lower it (the route reads the binding on every request).
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  get CATALOG_ROW_CEILING() {
    return ceiling.value;
  },
}));
// Every lookup of a per-path cached signed URL goes through unstable_cache:
// count them (a cold cache pays one Data Cache round trip for each).
vi.mock('next/cache', () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      cacheReads.count += 1;
      return fn(...args);
    },
}));
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

const ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const WH = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';

type Fixture = {
  id: string;
  organization_id: string;
  warehouse_id: string;
  name: string;
  status: string;
  deleted_at: null;
  is_rental: boolean;
  is_bundle: boolean | null;
  custom_fields: Record<string, unknown>;
  /** Ordering visibility (0413); every fixture starts shown. */
  order_catalog_visible?: boolean;
};

/**
 * A warehouse shaped like L4L's DC4: 400 orderable items (320 with an
 * uploaded photo, 20 with a book cover URL, 60 with neither), 2 bundles, and
 * 7 rental items (4 photos, 1 cover, 1 with nothing, and 1 rental that is also
 * a bundle, with a photo). Each run gets its own ids, so the service's
 * in-process URL memo never answers one test with another's work.
 */
function warehouse(prefix: string) {
  const id = (i: number) => `${prefix.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const items: Fixture[] = [];
  const photos = new Set<string>();
  const covers = new Set<string>();
  const add = (
    i: number,
    opts: { rental?: boolean; bundle?: boolean; photo?: boolean; cover?: boolean },
  ) => {
    const row: Fixture = {
      id: id(i),
      organization_id: ORG,
      warehouse_id: WH,
      name: `Item ${String(i).padStart(4, '0')}`,
      status: 'active',
      deleted_at: null,
      is_rental: opts.rental ?? false,
      is_bundle: opts.bundle ?? (i % 2 === 0 ? null : false),
      custom_fields: opts.cover ? { thumbnail_url: `https://covers.example/${i}.jpg` } : {},
      order_catalog_visible: true,
    };
    items.push(row);
    if (opts.photo) photos.add(row.id);
    if (opts.cover) covers.add(row.id);
  };
  let n = 0;
  for (let i = 0; i < 320; i++) add(n++, { photo: true });
  for (let i = 0; i < 20; i++) add(n++, { cover: true });
  for (let i = 0; i < 60; i++) add(n++, {});
  for (let i = 0; i < 2; i++) add(n++, { bundle: true, photo: true });
  const rentals: string[] = [];
  for (let i = 0; i < 4; i++) {
    rentals.push(id(n));
    add(n++, { rental: true, photo: true });
  }
  rentals.push(id(n));
  add(n++, { rental: true, cover: true });
  rentals.push(id(n));
  add(n++, { rental: true });
  rentals.push(id(n));
  add(n++, { rental: true, bundle: true, photo: true });

  const images = [...photos].map((itemId, i) => ({
    id: `img-${i}`,
    organization_id: ORG,
    item_id: itemId,
    storage_path: `${ORG}/${itemId}/master.webp`,
    is_primary: true,
    sort_order: 0,
  }));
  return { items, images, photos, covers, rentals };
}

/** inventory_items as PostgREST would answer. */
function servedItems(rows: Fixture[]) {
  return servedLikePostgrest(rows as unknown as Array<Record<string, unknown>>);
}

function setup(prefix: string, opts: { itemsError?: boolean } = {}) {
  const wh = warehouse(prefix);
  const stub = makeSupabaseStub({
    'inventory_items.select': opts.itemsError
      ? { data: null, error: { message: 'fetch failed' } }
      : servedItems(wh.items),
    'item_images.select': servedLikePostgrest(wh.images),
  });
  apiCtx.current = makeServiceContext(stub.client, { organizationId: ORG });
  return { ...wh, stub };
}

async function get(query: string) {
  const { GET } = await import('./route');
  const res = await GET(new NextRequest(`http://localhost/api/orders/catalog-thumbnails?${query}`));
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as { urls?: Record<string, string> },
    bytes: text.length,
  };
}

/** What one request cost: database reads, storage calls, cache lookups. */
function cost(stub: ReturnType<typeof makeSupabaseStub>, bytes: number, urls: number) {
  return {
    itemReads: stub.fromCalls.filter((t) => t === 'inventory_items').length,
    imageReads: stub.fromCalls.filter((t) => t === 'item_images').length,
    signCalls: createSignedUrlsMock.mock.calls.length + createSignedUrlMock.mock.calls.length,
    pathsSigned: createSignedUrlsMock.mock.calls.reduce(
      (n, [paths]) => n + (paths as string[]).length,
      0,
    ),
    cacheReads: cacheReads.count,
    urls,
    bytes,
  };
}

/**
 * `n` rental items, each with a photo. Names repeat in pairs and the ids run
 * against the names, so only name THEN id puts them in one order. Every run
 * gets its own id prefix (the service's in-process URL memo, see warehouse()).
 */
let rentalRun = 0;
function rentalRows(n: number): Fixture[] {
  rentalRun += 1;
  const prefix = `f${String(rentalRun).padStart(7, '0')}`;
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-0000-4000-8000-${String(n - i).padStart(12, '0')}`,
    organization_id: ORG,
    warehouse_id: WH,
    name: `Rental ${String(Math.floor(i / 2)).padStart(4, '0')}`,
    status: 'active',
    deleted_at: null,
    is_rental: true,
    is_bundle: null,
    custom_fields: {},
  }));
}

/** A primary photo for each of `rows`. */
function photosFor(rows: Fixture[]) {
  return rows.map((r, i) => ({
    id: `img-${i}`,
    organization_id: ORG,
    item_id: r.id,
    storage_path: `${ORG}/${r.id}/master.webp`,
    is_primary: true,
    sort_order: 0,
  }));
}

/** The route's own item read: the first inventory_items query it made. */
function firstChain(stub: ReturnType<typeof makeSupabaseStub>) {
  return {
    methods: stub.chainsAll.get('inventory_items.select')?.[0],
    args: stub.chainArgsAll.get('inventory_items.select')?.[0],
  };
}

beforeEach(() => {
  vi.resetModules();
  cacheReads.count = 0;
  ceiling.value = 10_000;
  reportError.mockClear();
  checkRateLimit.mockClear();
  createSignedUrlMock.mockReset();
  createSignedUrlsMock.mockReset();
  createSignedUrlsMock.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://signed.example/${path}`, error: null })),
    error: null,
  }));
});

describe('GET /api/orders/catalog-thumbnails', () => {
  // The two shapes nothing sends any more (the pre-storefront orders picker,
  // gone since 2026-07-21, and the rentals form before #266): each read every
  // orderable item in the warehouse (up to 500) and signed a photo for each.
  // Mutation caught: answering them again.
  it('without rentalsOnly=1 (the old orders picker and includeRentals=1): 400, nothing read or signed', async () => {
    for (const query of [
      `warehouseId=${WH}`,
      `warehouseId=${WH}&includeRentals=1`,
      `warehouseId=${WH}&rentalsOnly=0`,
      `warehouseId=${WH}&rentalsOnly=true`,
    ]) {
      const { stub } = setup('a');
      const { status, body } = await get(query);
      expect(status, query).toBe(400);
      expect(body).toEqual({ error: 'validation_error', message: 'rentalsOnly=1 is required' });
      expect(stub.fromCalls, query).toEqual([]);
    }
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  // Ordering visibility (0413): the orders picker's set never signs a photo
  // for an item hidden from new ordering. Main kept answering that set and
  // added order_catalog_visible = true to its read; this route refuses the
  // set outright (the test above), so a hidden item gets no URL because
  // nothing is read or signed for the request at all, shown or hidden.
  // Mutation caught: answering the default request again, with or without
  // the visibility filter.
  it('default: an item hidden from ordering gets no photo URL', async () => {
    const { stub, items, photos } = setup('e');
    const hidden = items
      .filter((it) => photos.has(it.id) && !it.is_rental && it.is_bundle !== true)
      .slice(0, 3);
    expect(hidden).toHaveLength(3);
    for (const it of hidden) it.order_catalog_visible = false;

    const { status, body } = await get(`warehouseId=${WH}`);

    expect(status).toBe(400);
    for (const it of hidden) expect(body.urls?.[it.id]).toBeUndefined();
    expect(body.urls).toBeUndefined();
    expect(stub.fromCalls).toEqual([]);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('rentalsOnly=1: reads exactly the New rental page rows and signs only their photos', async () => {
    const { stub, rentals, photos } = setup('b');
    const { status, body, bytes } = await get(`warehouseId=${WH}&rentalsOnly=1`);

    expect(status).toBe(200);
    // The page's own query: rentals of any kind (bundles too), by name then
    // id, every row, one 1000-row page at a time.
    expect(firstChain(stub)).toEqual({
      methods: ['select', 'eq', 'eq', 'eq', 'eq', 'is', 'order', 'order', 'range'],
      args: [
        ['id'],
        ['organization_id', ORG],
        ['warehouse_id', WH],
        ['status', 'active'],
        ['is_rental', true],
        ['deleted_at', null],
        ['name', { ascending: true }],
        ['id', { ascending: true }],
        [0, 999],
      ],
    });
    // 4 photos + the rental bundle's photo + 1 cover; the rental with nothing
    // has no entry, and no non-rental item appears.
    expect(Object.keys(body.urls!).sort()).toEqual(
      rentals.filter((id) => id !== rentals[5]).sort(),
    );
    const signed = createSignedUrlsMock.mock.calls.flatMap(([paths]) => paths as string[]);
    expect(signed.every((p) => rentals.some((id) => p.includes(id)))).toBe(true);
    expect(signed).toHaveLength([...photos].filter((id) => rentals.includes(id)).length);

    expect(cost(stub, bytes, Object.keys(body.urls!).length)).toEqual({
      itemReads: 2, // the rental read + one cover fallback read
      imageReads: 1,
      signCalls: 1,
      pathsSigned: 5,
      cacheReads: 5,
      urls: 6,
      bytes: expect.any(Number),
    });
  });

  it('rentalsOnly=1: more than 1000 rental items are all read and signed (no 500-row limit)', async () => {
    const rows = rentalRows(1234);
    const stub = makeSupabaseStub({
      'inventory_items.select': servedItems(rows),
      'item_images.select': servedLikePostgrest(photosFor(rows)),
    });
    apiCtx.current = makeServiceContext(stub.client, { organizationId: ORG });

    const { status, body } = await get(`warehouseId=${WH}&rentalsOnly=1`);

    expect(status).toBe(200);
    expect(Object.keys(body.urls!).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(stub.chainArgsAll.get('inventory_items.select')?.map((args) => args.at(-1))).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('rentalsOnly=1: a failed item read answers 500 (the page retries), never an empty map', async () => {
    const { stub } = setup('e', { itemsError: true });
    const { status, body } = await get(`warehouseId=${WH}&rentalsOnly=1`);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'internal_error',
      message: 'Could not load rental item photos.',
    });
    expect(stub.fromCalls).not.toContain('item_images');
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
  });

  // The catch used to discard the error: a 500 with nothing in the server log
  // to say why. The cause goes to the reporter; the answer stays generic.
  it('rentalsOnly=1: a failed item read reports its cause server-side, and only there', async () => {
    setup('g', { itemsError: true });
    const { status, body } = await get(`warehouseId=${WH}&rentalsOnly=1`);
    expect(status).toBe(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('fetch failed');
    expect(context).toEqual({
      tag: 'orders.catalog-thumbnails.rentals',
      organizationId: ORG,
      extra: { warehouseId: WH },
    });
    expect(JSON.stringify(body)).not.toContain('fetch failed');
  });

  it('rentalsOnly=1: a page that fails AFTER the first answers 500, never the first page signed', async () => {
    const rows = rentalRows(1234);
    const serve = servedItems(rows);
    const stub = makeSupabaseStub({
      'inventory_items.select': (call: MockCall) =>
        callArgs(call, 'range')?.[0] === 1000
          ? { data: null, error: { message: 'upstream timeout' } }
          : serve(call),
      'item_images.select': servedLikePostgrest(photosFor(rows)),
    });
    apiCtx.current = makeServiceContext(stub.client, { organizationId: ORG });

    const { status, body } = await get(`warehouseId=${WH}&rentalsOnly=1`);

    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'internal_error',
      message: 'Could not load rental item photos.',
    });
    expect(stub.chainArgsAll.get('inventory_items.select')?.map((args) => args.at(-1))).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect((reportError.mock.calls[0]?.[0] as Error | undefined)?.message).toContain(
      'upstream timeout',
    );
  });

  it('rentalsOnly=1: signing stops at CATALOG_ROW_CEILING, the first rows by name then id', async () => {
    ceiling.value = 1500;
    const rows = rentalRows(2000);
    const stub = makeSupabaseStub({
      'inventory_items.select': servedItems(rows),
      'item_images.select': servedLikePostgrest(photosFor(rows)),
    });
    apiCtx.current = makeServiceContext(stub.client, { organizationId: ORG });

    const { status, body } = await get(`warehouseId=${WH}&rentalsOnly=1`);

    expect(status).toBe(200);
    // The last window is cut to the ceiling, and nothing past it is asked for.
    expect(stub.chainArgsAll.get('inventory_items.select')?.map((args) => args.at(-1))).toEqual([
      [0, 999],
      [1000, 1499],
    ]);
    const firstByNameThenId = [...rows]
      .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1))
      .slice(0, 1500)
      .map((r) => r.id);
    expect(Object.keys(body.urls!).sort()).toEqual([...firstByNameThenId].sort());
    const signed = createSignedUrlsMock.mock.calls.reduce(
      (n, [paths]) => n + (paths as string[]).length,
      0,
    );
    expect(signed).toBe(1500);
  });

  it('asks for a warehouse and a session', async () => {
    setup('f');
    expect((await get('rentalsOnly=1')).status).toBe(400);
    apiCtx.current = null;
    expect((await get(`warehouseId=${WH}&rentalsOnly=1`)).status).toBe(401);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('GET /api/orders/catalog-thumbnails: rate limit', () => {
  it("counts every request against the caller's own bucket, 60 a minute, before any read", async () => {
    const { stub } = setup('h');
    apiCtx.current = makeServiceContext(stub.client, { organizationId: ORG, userId: 'user-7' });
    const { status } = await get(`warehouseId=${WH}&rentalsOnly=1`);
    expect(status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    // Open on a limiter outage (the default mode), like the other signed-in routes.
    expect(checkRateLimit.mock.calls[0]).toEqual(['catalog-thumbnails:user:user-7', 60, 60_000]);
  });

  // Mutation caught: no limit at all, or one checked after the reads and
  // the signing it is there to bound.
  it('over the limit: 429 with retry-after, and nothing read or signed', async () => {
    const { stub } = setup('i');
    checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      count: 60,
      resetAt: Date.now() + 42_000,
    });
    const { GET } = await import('./route');
    const res = await GET(
      new NextRequest(
        `http://localhost/api/orders/catalog-thumbnails?warehouseId=${WH}&rentalsOnly=1`,
      ),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'rate_limited',
      message: 'Too many photo requests. Try again in a minute.',
    });
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(41);
    expect(retryAfter).toBeLessThanOrEqual(42);
    expect(stub.fromCalls).toEqual([]);
    expect(createSignedUrlsMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
});
