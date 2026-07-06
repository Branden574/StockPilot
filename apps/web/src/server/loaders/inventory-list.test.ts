import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAdminClientMock, signedUrlsMock } = vi.hoisted(() => ({
  createAdminClientMock: vi.fn(),
  signedUrlsMock: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

vi.mock('@/server/services/context', () => ({
  withContext: vi.fn(),
  assertPermission: vi.fn(),
  ServiceError: class ServiceError extends Error {},
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

// The loader must NEVER sign URLs inside its cached fn (nested
// unstable_cache writes clobber the shared 25-day per-path entries);
// resolveInventoryListImages signs per request through this seam.
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    signedUrls(paths: string[]) {
      return signedUrlsMock(paths);
    }
  },
}));

vi.mock('@/server/services/lib/paginate', () => ({
  fetchAllRows: vi.fn(async () => []),
}));

// movements.ts is imported for REAL here (the trend-parity test runs the
// actual getItemTrends against the actual cached-bucket derivation), so
// its RLS helper import chain must be stubbed out.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {},
}));

import { revalidateTag, unstable_cache } from 'next/cache';

import type { Permission } from '@stockpilot/core';

import { isSiteLocation } from '@/lib/locations/groups';
import { withContext, type ServiceContext } from '@/server/services/context';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { getItemTrends } from '@/server/services/movements';

import {
  canUseSharedInventoryCaches,
  deriveInventoryTrends,
  inventoryListTag,
  isDefaultInventoryView,
  loadInventoryList,
  loadInventoryLookups,
  loadInventoryTrendBuckets,
  loadInventoryValueOnHand,
  resolveInventoryListImages,
  revalidateInventoryList,
  revalidateInventoryListForCurrentOrg,
  type InventoryListCachedRow,
  type InventoryListLookups,
} from './inventory-list';

describe('isDefaultInventoryView', () => {
  describe('cache hits (exact default view)', () => {
    it('accepts empty params for both views', () => {
      expect(isDefaultInventoryView({}, 'items')).toBe(true);
      expect(isDefaultInventoryView({}, 'books')).toBe(true);
    });

    it('accepts params explicitly set to their defaults', () => {
      expect(
        isDefaultInventoryView(
          { status: 'active', type: 'product', page: '1', sort: 'updated_desc' },
          'items',
        ),
      ).toBe(true);
    });

    it('accepts an empty-string q (live path applies no filter for it)', () => {
      expect(isDefaultInventoryView({ q: '' }, 'items')).toBe(true);
    });

    it('accepts whitespace-only q and rack (VERIFIED parity: list() only applies either filter under `value && value.trim()`, so the live path is a no-op too)', () => {
      expect(isDefaultInventoryView({ q: '   ' }, 'items')).toBe(true);
      expect(isDefaultInventoryView({ rack: '   ' }, 'items')).toBe(true);
      expect(isDefaultInventoryView({ q: ' ', rack: ' ' }, 'books')).toBe(true);
    });

    it('accepts empty id-filter arrays (parseIdList yields [])', () => {
      expect(isDefaultInventoryView({ cat: [], loc: [], charter: [] }, 'items')).toBe(true);
    });

    it('ignores a stray type param on the books view (books hardcodes item_type)', () => {
      expect(isDefaultInventoryView({ type: 'asset' }, 'books')).toBe(true);
    });
  });

  describe('cache bypasses (any data-affecting param)', () => {
    it('bypasses on a search query', () => {
      expect(isDefaultInventoryView({ q: 'widget' }, 'items')).toBe(false);
    });

    it('bypasses on non-default status values', () => {
      for (const status of ['archived', 'discontinued', 'all', 'garbage', '']) {
        expect(isDefaultInventoryView({ status }, 'items')).toBe(false);
      }
    });

    it('bypasses on stock filters', () => {
      expect(isDefaultInventoryView({ stock: 'low' }, 'items')).toBe(false);
      expect(isDefaultInventoryView({ stock: 'out' }, 'items')).toBe(false);
    });

    it('bypasses on non-product types for the items view', () => {
      for (const type of ['all', 'book', 'asset', 'consumable', 'garbage']) {
        expect(isDefaultInventoryView({ type }, 'items')).toBe(false);
      }
    });

    it('bypasses on any page other than the literal "1"', () => {
      expect(isDefaultInventoryView({ page: '2' }, 'items')).toBe(false);
      // These coerce back to page 1 on the live path, but the helper is
      // deliberately conservative: only the canonical form hits cache.
      expect(isDefaultInventoryView({ page: '0' }, 'items')).toBe(false);
      expect(isDefaultInventoryView({ page: 'abc' }, 'items')).toBe(false);
    });

    it('bypasses on non-default sorts', () => {
      expect(isDefaultInventoryView({ sort: 'name_asc' }, 'items')).toBe(false);
      expect(isDefaultInventoryView({ sort: 'qty_desc' }, 'books')).toBe(false);
    });

    it('bypasses on category / location / charter id filters', () => {
      expect(isDefaultInventoryView({ cat: 'c1' }, 'items')).toBe(false);
      expect(isDefaultInventoryView({ loc: ['l1'] }, 'items')).toBe(false);
      expect(isDefaultInventoryView({ charter: ['generic'] }, 'books')).toBe(false);
    });

    it('bypasses on a rack filter', () => {
      expect(isDefaultInventoryView({ rack: '38-A' }, 'items')).toBe(false);
    });

    it('bypasses when a repeated param arrives as an array', () => {
      expect(
        isDefaultInventoryView({ q: ['a', 'b'] as unknown as string }, 'items'),
      ).toBe(false);
    });
  });
});

describe('inventoryListTag / revalidateInventoryList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the per-org tag', () => {
    expect(inventoryListTag('org-1')).toBe('inventory-list-org-1');
  });

  it('revalidates the org tag with IMMEDIATE hard expiry ({ expire: 0 } — the "max" profile is stale-while-revalidate and would serve the pre-write entry once more)', () => {
    revalidateInventoryList('org-1');
    expect(revalidateTag).toHaveBeenCalledWith('inventory-list-org-1', { expire: 0 });
  });

  it('current-org helper resolves the org from withContext', async () => {
    vi.mocked(withContext).mockResolvedValue({
      organizationId: 'org-2',
    } as Awaited<ReturnType<typeof withContext>>);

    await revalidateInventoryListForCurrentOrg();

    expect(revalidateTag).toHaveBeenCalledWith('inventory-list-org-2', { expire: 0 });
  });

  it('current-org helper never throws (a failed invalidation must not fail the write)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(withContext).mockRejectedValue(new Error('no request scope'));

    await expect(revalidateInventoryListForCurrentOrg()).resolves.toBeUndefined();

    expect(revalidateTag).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/* ---- loader payload shape --------------------------------------------- */

/**
 * Chainable PostgREST-style stub: every filter/order method returns the
 * builder; awaiting it (or calling maybeSingle) resolves the configured
 * result.
 */
function makeBuilder(result: unknown) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'or', 'order', 'range', 'limit']) {
    builder[m] = vi.fn(chain);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

function makeAdmin(resultsByTable: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) =>
      makeBuilder(resultsByTable[table] ?? { data: [], error: null }),
    ),
  };
}

const baseItem = {
  id: 'i1',
  sku: 'SKU-1',
  barcode: null,
  model_number: null,
  name: 'Widget',
  description: null,
  status: 'active' as const,
  quantity_on_hand: 10,
  reorder_point: 0,
  unit_cost: 2,
  retail_price: 5,
  category_id: null,
  supplier_id: null,
  primary_location_id: null,
  warehouse_id: null,
  charter_id: null,
  tracking_type: 'none' as const,
  item_type: 'product' as const,
  custom_fields: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const emptyModuleGate = {
  organization_modules: { data: { enabled: false }, error: null },
  organizations: { data: { all_modules_comp: false }, error: null },
};

describe('loadInventoryList (cached payload shape)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches image storage PATHS (+ raw lqip), never signed URLs, and never signs inside the cached fn', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        ...emptyModuleGate,
        inventory_items: { data: [baseItem], count: 1, error: null },
        item_stock_levels: { data: [], error: null },
        item_images: {
          data: [
            {
              item_id: 'i1',
              storage_path: 'org/items/i1/a.jpg',
              thumb_path: 'org/items/i1/a-thumb.webp',
              lqip: 'data:image/webp;base64,xx',
              is_primary: true,
              sort_order: 0,
            },
          ],
          error: null,
        },
      }),
    );

    const payload = await loadInventoryList('org-1', 'all', 'items');

    expect(payload.total).toBe(1);
    expect(payload.items).toHaveLength(1);
    const row = payload.items[0]!;
    expect(row.image_storage_path).toBe('org/items/i1/a.jpg');
    expect(row.image_thumb_path).toBe('org/items/i1/a-thumb.webp');
    expect(row.image_lqip).toBe('data:image/webp;base64,xx');
    // The cached payload must NOT carry URLs — URL fields only exist
    // after per-request resolution.
    expect(row).not.toHaveProperty('image_url');
    expect(row).not.toHaveProperty('image_thumb_url');
    // Finding-2 regression guard: signing inside the cached fn would
    // write back through the nested unstable_cache and clobber the
    // shared 25-day per-path entries on every recompute.
    expect(signedUrlsMock).not.toHaveBeenCalled();
  });

  it('kind-NULL holdings: row-summary math uses the RAW kind (live list() parity); only the placement lines coalesce NULL → unplaced (live placementBreakdown() parity)', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        ...emptyModuleGate,
        inventory_items: { data: [baseItem], count: 1, error: null },
        item_stock_levels: {
          data: [
            {
              item_id: 'i1',
              location_id: 'L1',
              quantity: 4,
              locations: { name: 'Mystery', kind: null },
            },
            {
              item_id: 'i1',
              location_id: 'L2',
              quantity: 3,
              locations: { name: 'Stage', kind: 'staging' },
            },
          ],
          error: null,
        },
        item_images: { data: [], error: null },
      }),
    );

    const payload = await loadInventoryList('org-1', 'all', 'items');
    const row = payload.items[0]!;

    // Live list() scan: a NULL locations.kind contributes to neither
    // staged nor unplaced nor placed_racks.
    expect(row.staged_quantity).toBe(3);
    expect(row.unplaced_quantity).toBe(0);
    expect(row.placed_quantity).toBe(7); // 10 − 3 staged − 0 unplaced
    expect(row.placed_racks).toEqual([]);

    // Live placementBreakdown(): NULL kind IS coalesced for the lines,
    // and staging ranks before unplaced.
    expect(payload.placement['i1']).toEqual([
      { locationId: 'L2', label: 'Staging', kind: 'staging', quantity: 3 },
      { locationId: 'L1', label: 'Unplaced', kind: 'unplaced', quantity: 4 },
    ]);
  });
});

/* ---- per-request image-URL resolution ---------------------------------- */

function cachedRow(over: Partial<InventoryListCachedRow> = {}): InventoryListCachedRow {
  return {
    ...baseItem,
    staged_quantity: 0,
    unplaced_quantity: 0,
    placed_quantity: 10,
    placed_racks: [],
    image_storage_path: null,
    image_thumb_path: null,
    image_lqip: null,
    ...over,
  };
}

describe('resolveInventoryListImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // adminReadContext() constructs the service-role client; the
    // resolver only feeds it to ItemImagesService (mocked above).
    createAdminClientMock.mockReturnValue({});
  });

  it('resolves master + thumb URLs through the shared per-path cache and strips the path fields (rows end shape-identical to the live branch)', async () => {
    signedUrlsMock.mockResolvedValue(
      new Map([
        ['p/master.jpg', 'https://signed/master'],
        ['p/thumb.webp', 'https://signed/thumb'],
      ]),
    );

    const rows = await resolveInventoryListImages('org-1', [
      cachedRow({
        image_storage_path: 'p/master.jpg',
        image_thumb_path: 'p/thumb.webp',
        image_lqip: 'blur',
      }),
    ]);

    expect(signedUrlsMock).toHaveBeenCalledWith(['p/master.jpg', 'p/thumb.webp']);
    expect(rows[0]!.image_url).toBe('https://signed/master');
    expect(rows[0]!.image_thumb_url).toBe('https://signed/thumb');
    expect(rows[0]!.image_lqip).toBe('blur');
    expect(rows[0]!).not.toHaveProperty('image_storage_path');
    expect(rows[0]!).not.toHaveProperty('image_thumb_path');
  });

  it('tolerates an individual master-sign failure exactly like the live path: falls back to custom_fields.thumbnail_url with thumb/lqip nulled, never throws', async () => {
    signedUrlsMock.mockResolvedValue(new Map());

    const rows = await resolveInventoryListImages('org-1', [
      cachedRow({
        custom_fields: { thumbnail_url: 'https://cdn/books/cover.jpg' },
        image_storage_path: 'p/corrupt.jpg',
        image_thumb_path: 'p/corrupt-thumb.webp',
        image_lqip: 'blur',
      }),
    ]);

    expect(rows[0]!.image_url).toBe('https://cdn/books/cover.jpg');
    expect(rows[0]!.image_thumb_url).toBeNull();
    expect(rows[0]!.image_lqip).toBeNull();
  });

  it('signed thumb without a signed master is treated as image-less (mirrors primaryImagesWithThumbsForItems, which omits items whose master failed)', async () => {
    signedUrlsMock.mockResolvedValue(new Map([['p/thumb.webp', 'https://signed/thumb']]));

    const rows = await resolveInventoryListImages('org-1', [
      cachedRow({
        image_storage_path: 'p/master.jpg',
        image_thumb_path: 'p/thumb.webp',
        image_lqip: 'blur',
      }),
    ]);

    expect(rows[0]!.image_url).toBeNull();
    expect(rows[0]!.image_thumb_url).toBeNull();
    expect(rows[0]!.image_lqip).toBeNull();
  });

  it('skips the signing round-trip entirely when no row has an image path', async () => {
    const rows = await resolveInventoryListImages('org-1', [
      cachedRow({ custom_fields: { thumbnail_url: 'https://cdn/x.jpg' } }),
      cachedRow(),
    ]);

    expect(signedUrlsMock).not.toHaveBeenCalled();
    expect(rows[0]!.image_url).toBe('https://cdn/x.jpg');
    expect(rows[1]!.image_url).toBeNull();
  });
});

/* ---- shared-cache gate --------------------------------------------------- */

describe('canUseSharedInventoryCaches (the org-shared cache gate)', () => {
  it('allows manager and above (static role defaults include items:read)', () => {
    expect(canUseSharedInventoryCaches({ role: 'owner' })).toBe(true);
    expect(canUseSharedInventoryCaches({ role: 'admin' })).toBe(true);
    expect(canUseSharedInventoryCaches({ role: 'manager' })).toBe(true);
  });

  it('NEVER allows staff or viewer — their visibility is user-scoped (warehouse assignments / category restrictions), even with items:read granted', () => {
    expect(canUseSharedInventoryCaches({ role: 'staff' })).toBe(false);
    expect(canUseSharedInventoryCaches({ role: 'viewer' })).toBe(false);
    // items:read alone must not open the shared cache to a user-scoped
    // role class — the role floor comes first.
    expect(
      canUseSharedInventoryCaches({
        role: 'staff',
        permissions: new Set<Permission>(['items:read']),
      }),
    ).toBe(false);
    expect(
      canUseSharedInventoryCaches({
        role: 'viewer',
        permissions: new Set<Permission>(['items:read']),
      }),
    ).toBe(false);
  });

  it('denies a manager whose items:read was revoked via configurable-permission overrides', () => {
    expect(
      canUseSharedInventoryCaches({ role: 'manager', permissions: new Set<Permission>() }),
    ).toBe(false);
    expect(
      canUseSharedInventoryCaches({
        role: 'manager',
        permissions: new Set<Permission>(['items:update']),
      }),
    ).toBe(false);
  });
});

/* ---- filter-independent sub-loaders -------------------------------------- */

describe('loadInventoryLookups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const categoryRows = [
    { id: 'c1', name: 'Bikes', color: '#f00' },
    { id: 'c2', name: 'Parts', color: null },
  ];
  const locationRows = [
    { id: 'l1', name: 'Main Warehouse', type: 'warehouse', kind: null },
    { id: 'l2', name: 'Rack 1-A', type: null, kind: 'rack' }, // placement — excluded
    { id: 'l3', name: 'Staging', type: null, kind: 'staging' }, // system — excluded
    { id: 'l4', name: 'Van', type: 'vehicle', kind: null },
  ];
  const supplierRows = [{ id: 's1', name: 'Acme' }];
  const tagRows = [{ id: 't1', name: 'fragile', color: '#0f0' }];
  const charterRows = [
    { id: 'ch1', name: 'North', code: 'N1' },
    { id: 'ch2', name: 'South', code: null },
  ];

  function adminWithLookups(overrides: Record<string, unknown> = {}) {
    return makeAdmin({
      organization_modules: { data: { enabled: true }, error: null },
      organizations: { data: { all_modules_comp: false }, error: null },
      categories: { data: categoryRows, error: null },
      locations: { data: locationRows, error: null },
      suppliers: { data: supplierRows, error: null },
      tags: { data: tagRows, error: null },
      charters: { data: charterRows, error: null },
      ...overrides,
    });
  }

  it('produces shapes identical to the pages’ live-branch assembly over the same rows (cached-vs-live payload parity)', async () => {
    createAdminClientMock.mockReturnValue(adminWithLookups());

    const cached = await loadInventoryLookups('org-1');

    // Verbatim replica of the pages' fetchLiveLookups() mapping applied
    // to the same underlying rows. LocationsService.list({ sitesOnly })
    // filters with the SAME shared isSiteLocation predicate the loader
    // uses, so applying it here mirrors the live service exactly.
    const live: InventoryListLookups = {
      categories: categoryRows.map((c) => ({
        id: c.id,
        name: c.name,
        color: (c.color as string | null) ?? null,
      })),
      locations: locationRows
        .filter(isSiteLocation)
        .map((l) => ({ id: l.id, name: l.name })),
      suppliers: supplierRows.map((s) => ({ id: s.id, name: s.name })),
      tags: tagRows.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      charters: charterRows.map((c) => ({ id: c.id, name: c.name, code: c.code ?? null })),
    };

    expect(cached).toEqual(live);
    // Racks/staging never reach the picker — only real sites survive.
    expect(cached.locations.map((l) => l.id)).toEqual(['l1', 'l4']);
  });

  it('suppliers fail CLOSED to [] when the module is off (no entitlement widening); the other lookups still serve', async () => {
    createAdminClientMock.mockReturnValue(
      adminWithLookups({
        organization_modules: { data: { enabled: false }, error: null },
      }),
    );

    const cached = await loadInventoryLookups('org-1');

    expect(cached.suppliers).toEqual([]);
    expect(cached.categories).toHaveLength(2);
  });

  it('throws (never caches) when any lookup query fails', async () => {
    createAdminClientMock.mockReturnValue(
      adminWithLookups({ categories: { data: null, error: { message: 'boom' } } }),
    );

    await expect(loadInventoryLookups('org-1')).rejects.toThrow(/categories query failed/);
  });
});

describe('loadInventoryValueOnHand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums qty × cost over the skinny mirror with the same coercion formula list() uses', async () => {
    vi.mocked(fetchAllRows).mockResolvedValueOnce([
      { quantity_on_hand: 2, unit_cost: 3, reorder_point: 0 },
      { quantity_on_hand: 4, unit_cost: 1.5, reorder_point: 9 },
      // null/garbage coerce to 0 — identical to the live reduce.
      { quantity_on_hand: null, unit_cost: 10, reorder_point: 0 },
    ] as never);
    createAdminClientMock.mockReturnValue(makeAdmin({}));

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).resolves.toBe(12);
  });

  it('throws (never caches) when the sum pagination fails', async () => {
    vi.mocked(fetchAllRows).mockRejectedValueOnce(new Error('sum page failed'));
    createAdminClientMock.mockReturnValue(makeAdmin({}));

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).rejects.toThrow(
      'sum page failed',
    );
  });
});

describe('loadInventoryTrendBuckets + deriveInventoryTrends (filtered-view trends)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const dayMs = 24 * 60 * 60 * 1000;

  it('derives series IDENTICAL to the live getItemTrends for the same movements (cached-vs-live parity)', async () => {
    const now = Date.now();
    // Mid-day offsets so the two paths' independently computed window
    // anchors (ms apart) can never flip a movement across a day bucket.
    const movementRows = [
      { item_id: 'i1', quantity_change: 5, created_at: new Date(now - 2.5 * dayMs).toISOString() },
      { item_id: 'i1', quantity_change: -2, created_at: new Date(now - 0.5 * dayMs).toISOString() },
      { item_id: 'i2', quantity_change: 7, created_at: new Date(now - 12.5 * dayMs).toISOString() },
    ];
    const pageItems = [
      { id: 'i1', quantityOnHand: 10 },
      { id: 'i2', quantityOnHand: 7 },
      { id: 'i3', quantityOnHand: 4 }, // no movements → flat series
    ];

    // LIVE path: the real getItemTrends over the same rows.
    vi.mocked(fetchAllRows).mockResolvedValueOnce(movementRows as never);
    const live = await getItemTrends(pageItems, {
      ctx: { organizationId: 'org-1', supabase: {} } as unknown as ServiceContext,
    });

    // CACHED path: org-wide buckets → per-request derivation.
    vi.mocked(fetchAllRows).mockResolvedValueOnce(movementRows as never);
    createAdminClientMock.mockReturnValue(makeAdmin({}));
    const buckets = await loadInventoryTrendBuckets('org-1');
    const derived = deriveInventoryTrends(pageItems, buckets);

    expect(derived).toEqual(live);
    // Shape parity: EVERY requested row gets a series, even with no
    // movements in the window (flat qty line at current quantity).
    expect([...derived.keys()].sort()).toEqual(['i1', 'i2', 'i3']);
    expect(derived.get('i3')!.qtySeries).toEqual(new Array(14).fill(4));
    expect(derived.get('i3')!.moveSeries).toEqual(new Array(14).fill(0));
    // Sparkline endpoint always equals the row's current on-hand.
    expect(derived.get('i1')!.qtySeries[13]).toBe(10);
  });

  it('throws (never caches) when the movements pagination fails', async () => {
    vi.mocked(fetchAllRows).mockRejectedValueOnce(new Error('movements page failed'));
    createAdminClientMock.mockReturnValue(makeAdmin({}));

    await expect(loadInventoryTrendBuckets('org-1')).rejects.toThrow('movements page failed');
  });
});

/* ---- cache wiring (tags + version keys + TTL) ----------------------------- */

describe('sub-loader cache wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all four sub-loaders cache under the ONE org tag revalidateInventoryList expires, each with its own version key and the 60s TTL', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        ...emptyModuleGate,
        inventory_items: { data: [], count: 0, error: null },
        item_stock_levels: { data: [], error: null },
        item_images: { data: [], error: null },
      }),
    );

    await loadInventoryList('org-9', 'all', 'items');

    const calls = vi.mocked(unstable_cache).mock.calls as unknown as Array<
      [unknown, string[], { revalidate: number; tags: string[] }]
    >;
    // Pin the version keys: a rename here silently orphans warm entries
    // (one-time cold recompute) — bump deliberately, never accidentally.
    expect(calls.map(([, keyParts]) => keyParts[0]).sort()).toEqual([
      'inventory-list-v3',
      'inventory-lookups-v1',
      'inventory-trend-buckets-v1',
      'inventory-value-v1',
    ]);
    for (const [, keyParts, opts] of calls) {
      expect(opts.tags, `${keyParts[0]} must carry the shared org tag`).toEqual([
        inventoryListTag('org-9'),
      ]);
      expect(opts.revalidate, `${keyParts[0]} must keep the 60s TTL`).toBe(60);
    }
  });
});
