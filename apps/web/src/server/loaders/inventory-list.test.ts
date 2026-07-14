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
import {
  bucketsFromTrendAggregates,
  bucketTrendMovements,
  type TrendAggregateRow,
} from '@/server/services/lib/item-trends';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { getItemTrends } from '@/server/services/movements';

import { INSTANT_MODE_MAX_ROWS } from '@/lib/inventory/instant-mode';

import {
  canUseSharedInventoryCaches,
  deriveInventoryTrends,
  inventoryListTag,
  isDefaultInventoryView,
  loadInventoryDataset,
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

function makeAdmin(
  resultsByTable: Record<string, unknown>,
  rpcResults: Record<string, unknown> = {},
) {
  return {
    from: vi.fn((table: string) =>
      makeBuilder(resultsByTable[table] ?? { data: [], error: null }),
    ),
    rpc: vi.fn((fn: string) => Promise.resolve(rpcResults[fn] ?? { data: [], error: null })),
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
  auto_archived: false,
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
    expect(row.rackHoldingsCount).toBe(0);

    // Live placementBreakdown(): NULL kind IS coalesced for the lines,
    // and staging ranks before unplaced.
    expect(payload.placement['i1']).toEqual([
      { locationId: 'L2', label: 'Staging', kind: 'staging', quantity: 3 },
      { locationId: 'L1', label: 'Unplaced', kind: 'unplaced', quantity: 4 },
    ]);
  });

  it('cross-warehouse split (same rack NAME, two distinct location_ids): placed_racks collapses to one name, but rackHoldingsCount stays 2 — matching the server\'s by-location_id split gate', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        ...emptyModuleGate,
        inventory_items: { data: [baseItem], count: 1, error: null },
        item_stock_levels: {
          data: [
            {
              item_id: 'i1',
              location_id: 'rack-wh-a',
              quantity: 4,
              locations: { name: '1-A', kind: 'rack' },
            },
            {
              item_id: 'i1',
              location_id: 'rack-wh-b',
              quantity: 6,
              locations: { name: '1-A', kind: 'rack' },
            },
          ],
          error: null,
        },
        item_images: { data: [], error: null },
      }),
    );

    const payload = await loadInventoryList('org-1', 'all', 'items');
    const row = payload.items[0]!;

    // Display list dedupes by NAME — this is the false-negative the
    // Unit B review caught: naively reading placed_racks.length here
    // would report "not split" even though the stock sits on two
    // physically distinct holdings.
    expect(row.placed_racks).toEqual(['1-A']);
    // The split-warning source of truth: distinct HOLDINGS by
    // location_id, which the server's rackHoldingsByItem grouping
    // (placeItemsOntoRackByName) also refuses to move.
    expect(row.rackHoldingsCount).toBe(2);
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
    rackHoldingsCount: 0,
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

describe('resolveInventoryListImages payloadDiet (rank 5 — instant dataset only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminClientMock.mockReturnValue({});
  });

  it('thumb-carrying rows ship ONLY the thumb: the master path is never even requested for signing, image_url and image_lqip are nulled', async () => {
    signedUrlsMock.mockResolvedValue(new Map([['p/thumb.webp', 'https://signed/thumb']]));

    const rows = await resolveInventoryListImages(
      'org-1',
      [
        cachedRow({
          image_storage_path: 'p/master.jpg',
          image_thumb_path: 'p/thumb.webp',
          image_lqip: 'blur',
        }),
      ],
      { payloadDiet: true },
    );

    // Halved sign fan-out: only the thumb path went to the signer.
    expect(signedUrlsMock).toHaveBeenCalledWith(['p/thumb.webp']);
    expect(rows[0]!.image_url).toBeNull();
    expect(rows[0]!.image_thumb_url).toBe('https://signed/thumb');
    expect(rows[0]!.image_lqip).toBeNull();
  });

  it('thumbless rows keep their master inline — it is their only image', async () => {
    signedUrlsMock.mockResolvedValue(new Map([['p/master.jpg', 'https://signed/master']]));

    const rows = await resolveInventoryListImages(
      'org-1',
      [cachedRow({ image_storage_path: 'p/master.jpg' })],
      { payloadDiet: true },
    );

    expect(signedUrlsMock).toHaveBeenCalledWith(['p/master.jpg']);
    expect(rows[0]!.image_url).toBe('https://signed/master');
    expect(rows[0]!.image_thumb_url).toBeNull();
  });

  it('a failed thumb sign degrades to the cfThumb fallback instead of throwing', async () => {
    signedUrlsMock.mockResolvedValue(new Map());

    const rows = await resolveInventoryListImages(
      'org-1',
      [
        cachedRow({
          custom_fields: { thumbnail_url: 'https://cdn/books/cover.jpg' },
          image_storage_path: 'p/master.jpg',
          image_thumb_path: 'p/thumb.webp',
        }),
      ],
      { payloadDiet: true },
    );

    expect(rows[0]!.image_url).toBe('https://cdn/books/cover.jpg');
    expect(rows[0]!.image_thumb_url).toBeNull();
  });

  it('default (no opts) stays full-fidelity — the 30-row payload and every server-mode path are unchanged', async () => {
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

  it('delegates to ONE inventory_value_on_hand RPC (mig 0227) — org + item_type from the cache key, NO row paging (was 50+ serial pages at 50k SKUs)', async () => {
    const admin = makeAdmin({}, { inventory_value_on_hand: { data: 42, error: null } });
    createAdminClientMock.mockReturnValue(admin);

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).resolves.toBe(42);

    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledWith('inventory_value_on_hand', {
      p_organization_id: 'org-1',
      p_item_type: 'product',
      p_warehouse_id: null,
    });
    // The old JS-sum path paged rows through fetchAllRows — the RPC
    // replaces the transfer entirely.
    expect(fetchAllRows).not.toHaveBeenCalled();
  });

  it('books view + warehouse cache key map to p_item_type=book / p_warehouse_id (same predicate axes the JS mirror had)', async () => {
    const admin = makeAdmin({}, { inventory_value_on_hand: { data: 0, error: null } });
    createAdminClientMock.mockReturnValue(admin);

    await expect(loadInventoryValueOnHand('org-1', 'wh-7', 'books')).resolves.toBe(0);

    expect(admin.rpc).toHaveBeenCalledWith('inventory_value_on_hand', {
      p_organization_id: 'org-1',
      p_item_type: 'book',
      p_warehouse_id: 'wh-7',
    });
  });

  it('coerces a numeric-string result (PostgREST may serialize numerics as strings)', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({}, { inventory_value_on_hand: { data: '12.5', error: null } }),
    );

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).resolves.toBe(12.5);
  });

  it('throws (never caches) when the RPC fails', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({}, { inventory_value_on_hand: { data: null, error: { message: 'rpc boom' } } }),
    );

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).rejects.toThrow(
      'inventory-list value rpc failed: rpc boom',
    );
  });

  it('throws on a null/non-numeric RPC result instead of caching a bogus 0 (Number(null) is 0 — never cache a null)', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({}, { inventory_value_on_hand: { data: null, error: null } }),
    );

    await expect(loadInventoryValueOnHand('org-1', 'all', 'items')).rejects.toThrow(
      /non-numeric result/,
    );
  });
});

describe('loadInventoryTrendBuckets + deriveInventoryTrends (filtered-view trends)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const dayMs = 24 * 60 * 60 * 1000;

  /**
   * Independent simulation of migration 0223's SQL aggregate over raw
   * movement rows: WHERE created_at >= start_at, day_index =
   * clamp(floor(epoch diff / 86400), 0, 13), GROUP BY (item, day) with
   * SUM(quantity_change) + COUNT(*). Deliberately NOT written in terms
   * of bucketTrendMovements so the parity assertions compare two
   * implementations rather than one with itself. (The DB-side twin of
   * this simulation is the behavioral results_eq in
   * supabase/tests/0223_inventory_trend_buckets.test.sql.)
   */
  function simulateTrendAggregateRpc(
    rows: ReadonlyArray<{ item_id: string; quantity_change: number; created_at: string }>,
    startMs: number,
  ): TrendAggregateRow[] {
    const groups = new Map<string, { item_id: string; day_index: number; quantity_change: number; move_count: number }>();
    for (const r of rows) {
      const t = new Date(r.created_at).getTime();
      if (t < startMs) continue; // WHERE sm.created_at >= params.start_at
      const dayIdx = Math.min(13, Math.max(0, Math.floor((t - startMs) / dayMs)));
      const key = `${r.item_id}|${dayIdx}`;
      const g = groups.get(key) ?? {
        item_id: r.item_id,
        day_index: dayIdx,
        quantity_change: 0,
        move_count: 0,
      };
      g.quantity_change += r.quantity_change;
      g.move_count += 1;
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  // Mid-day offsets so independently computed window anchors (ms apart)
  // can never flip a movement across a day bucket. All rows sit INSIDE
  // the window or in the future: the production query/RPC both filter
  // created_at >= start, so an out-of-window row can never reach the JS
  // bucketing (whose lower clamp only ever fires on the boundary row).
  function fixtureMovements(now: number) {
    return [
      // i1: two movements in the SAME day bucket (aggregation), a third
      // in another day, and a FUTURE-dated row (clamps to day 13 on both
      // paths — reachable in prod: the window has no upper bound).
      { item_id: 'i1', quantity_change: 5, created_at: new Date(now - 2.5 * dayMs).toISOString() },
      { item_id: 'i1', quantity_change: -3, created_at: new Date(now - 2.6 * dayMs).toISOString() },
      { item_id: 'i1', quantity_change: -2, created_at: new Date(now - 0.5 * dayMs).toISOString() },
      { item_id: 'i1', quantity_change: 4, created_at: new Date(now + 0.1 * dayMs).toISOString() },
      // i2: single movement near the old edge of the window.
      { item_id: 'i2', quantity_change: 7, created_at: new Date(now - 12.5 * dayMs).toISOString() },
    ];
  }

  it('old JS bucketing and the RPC aggregate mapping produce DEEP-EQUAL buckets for identical fixture movements (provenance parity)', () => {
    const startMs = Date.now() - 14 * dayMs;
    const movementRows = fixtureMovements(startMs + 14 * dayMs);

    // (a) the pre-0223 cold-fill math: bucket raw rows in JS.
    const jsBuckets = bucketTrendMovements(movementRows, startMs);
    // (b) the new cold fill: simulated SQL aggregate → mapper.
    const rpcBuckets = bucketsFromTrendAggregates(
      simulateTrendAggregateRpc(movementRows, startMs),
    );

    expect(rpcBuckets).toEqual(jsBuckets);
    // Spot-check the aggregation actually merged the same-day pair and
    // clamped the future row rather than trivially matching on emptiness.
    expect(rpcBuckets['i1']![11]).toEqual({ change: 2, count: 2 }); // 5 + (−3)
    expect(rpcBuckets['i1']![13]).toEqual({ change: 2, count: 2 }); // −2 + clamped +4
    expect(rpcBuckets['i2']![1]).toEqual({ change: 7, count: 1 });
    expect(Object.keys(rpcBuckets).sort()).toEqual(['i1', 'i2']);
  });

  it('derives series IDENTICAL to the live getItemTrends for the same movements (cached-vs-live parity)', async () => {
    const now = Date.now();
    const movementRows = fixtureMovements(now);
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

    // CACHED path: the cold fill is now ONE RPC (migration 0223) — feed
    // the loader the SQL aggregate simulated over the SAME raw rows.
    const admin = makeAdmin(
      {},
      {
        inventory_trend_buckets: {
          data: simulateTrendAggregateRpc(movementRows, Date.now() - 14 * dayMs),
          error: null,
        },
      },
    );
    createAdminClientMock.mockReturnValue(admin);
    const buckets = await loadInventoryTrendBuckets('org-1');
    const derived = deriveInventoryTrends(pageItems, buckets);

    // The org scope must come from the loader's argument (cache key),
    // and the window from the shared TREND_WINDOW_DAYS constant.
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledWith('inventory_trend_buckets', {
      p_organization_id: 'org-1',
      p_days: 14,
    });

    expect(derived).toEqual(live);
    // Shape parity: EVERY requested row gets a series, even with no
    // movements in the window (flat qty line at current quantity).
    expect([...derived.keys()].sort()).toEqual(['i1', 'i2', 'i3']);
    expect(derived.get('i3')!.qtySeries).toEqual(new Array(14).fill(4));
    expect(derived.get('i3')!.moveSeries).toEqual(new Array(14).fill(0));
    // Sparkline endpoint always equals the row's current on-hand.
    expect(derived.get('i1')!.qtySeries[13]).toBe(10);
  });

  it('coerces string-typed numeric/bigint aggregate values (PostgREST may serialize numerics as strings)', () => {
    const buckets = bucketsFromTrendAggregates([
      { item_id: 'i1', day_index: 3, quantity_change: '2.5', move_count: '4' },
    ]);
    expect(buckets['i1']![3]).toEqual({ change: 2.5, count: 4 });
  });

  it('throws (never caches) when the RPC fails', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin(
        {},
        { inventory_trend_buckets: { data: null, error: { message: 'rpc boom' } } },
      ),
    );

    await expect(loadInventoryTrendBuckets('org-1')).rejects.toThrow(
      'inventory-list trend-buckets rpc failed: rpc boom',
    );
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
      // v2 = cold fill moved to the inventory_trend_buckets SQL
      // aggregate (mig 0223); provenance changed, so the key bumped.
      'inventory-trend-buckets-v2',
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

/* ---- instant-mode dataset loader ---------------------------------------- */

describe('loadInventoryDataset (instant-mode full-view rows)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** makeAdmin + per-table builder capture, so tests can assert QUERY
   *  CONSTRUCTION (which filters were applied) — not just results. */
  function makeRecordingAdmin(resultsByTable: Record<string, unknown>) {
    const buildersByTable: Record<string, Array<Record<string, ReturnType<typeof vi.fn>>>> = {};
    const admin = {
      from: vi.fn((table: string) => {
        const b = makeBuilder(resultsByTable[table] ?? { data: [], error: null });
        (buildersByTable[table] ??= []).push(b as never);
        return b;
      }),
    };
    return { admin, buildersByTable };
  }

  /** fetchAllRows stand-in that actually INVOKES buildPage once, so the
   *  query chain runs against the recording admin and its data flows
   *  back — mirrors one-page fetch behavior. */
  function fetchAllRowsInvokesBuildPage() {
    vi.mocked(fetchAllRows).mockImplementation(async (buildPage) => {
      const res = await (buildPage as (f: number, t: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>)(0, 999);
      if (res.error) throw new Error(res.error.message);
      return (res.data ?? []) as never;
    });
  }

  const archivedItem = { ...baseItem, id: 'i2', sku: 'SKU-2', name: 'Old Widget', status: 'archived' as const };
  const discontinuedItem = { ...baseItem, id: 'i3', sku: 'SKU-3', name: 'Dead Widget', status: 'discontinued' as const };

  it('includes EVERY status (no status filter on the query) and applies exactly the view-constant filters', async () => {
    fetchAllRowsInvokesBuildPage();
    const { admin, buildersByTable } = makeRecordingAdmin({
      inventory_items: {
        data: [baseItem, archivedItem, discontinuedItem],
        count: 3,
        error: null,
      },
      item_stock_levels: { data: [], error: null },
      item_images: { data: [], error: null },
    });
    createAdminClientMock.mockReturnValue(admin);

    const payload = await loadInventoryDataset('org-1', 'all', 'items');

    expect(payload).not.toBeNull();
    expect(payload!.items.map((r) => r.status)).toEqual(['active', 'archived', 'discontinued']);

    // Query construction: count query + rows query both carry the
    // view-constant filters and NOTHING request-variable.
    const itemBuilders = buildersByTable['inventory_items']!;
    expect(itemBuilders).toHaveLength(2); // head count + one rows page
    for (const b of itemBuilders) {
      const eqCalls = (b.eq as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          ['organization_id', 'org-1'],
          ['item_type', 'product'],
          ['is_rental', false],
        ]),
      );
      // status must NEVER be filtered — the client derives it. No
      // warehouse filter for the 'all' key either.
      expect(eqCalls.map(([col]) => col)).not.toContain('status');
      expect(eqCalls.map(([col]) => col)).not.toContain('warehouse_id');
      expect((b.is as ReturnType<typeof vi.fn>).mock.calls).toEqual(
        expect.arrayContaining([['deleted_at', null]]),
      );
    }
  });

  it('scopes to the warehouse when the key is a warehouse id, and to item_type=book for the books view', async () => {
    fetchAllRowsInvokesBuildPage();
    const { admin, buildersByTable } = makeRecordingAdmin({
      inventory_items: { data: [], count: 0, error: null },
      item_stock_levels: { data: [], error: null },
      item_images: { data: [], error: null },
    });
    createAdminClientMock.mockReturnValue(admin);

    await loadInventoryDataset('org-1', 'wh-7', 'books');

    for (const b of buildersByTable['inventory_items']!) {
      const eqCalls = (b.eq as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          ['warehouse_id', 'wh-7'],
          ['item_type', 'book'],
        ]),
      );
    }
  });

  it('rows are SHAPE-IDENTICAL to the paged v3 loader over the same underlying data (same assembleInventoryRows tail)', async () => {
    const tables = {
      ...emptyModuleGate,
      inventory_items: { data: [baseItem], count: 1, error: null },
      item_stock_levels: {
        data: [
          { item_id: 'i1', location_id: 'L1', quantity: 4, locations: { name: '1-A', kind: 'rack' } },
          { item_id: 'i1', location_id: 'L2', quantity: 3, locations: { name: 'Stage', kind: 'staging' } },
        ],
        error: null,
      },
      item_images: {
        data: [
          {
            item_id: 'i1',
            storage_path: 'p/a.jpg',
            thumb_path: 'p/a-thumb.webp',
            lqip: 'blur',
            is_primary: true,
            sort_order: 0,
          },
        ],
        error: null,
      },
    };

    // Paged loader (its second wave reads the builders directly).
    createAdminClientMock.mockReturnValue(makeAdmin(tables));
    vi.mocked(fetchAllRows).mockResolvedValue([] as never); // value + trend sub-loaders
    const paged = await loadInventoryList('org-1', 'all', 'items');

    // Dataset loader over the same rows (its second wave rides
    // fetchAllRows → invoke buildPage against the same tables).
    vi.clearAllMocks();
    fetchAllRowsInvokesBuildPage();
    createAdminClientMock.mockReturnValue(makeRecordingAdmin(tables).admin);
    const dataset = await loadInventoryDataset('org-1', 'all', 'items');

    expect(dataset).not.toBeNull();
    expect(dataset!.items).toEqual(paged.items);
    expect(dataset!.placement).toEqual(paged.placement);
    // Paths only, never URLs — same contract as the paged rows.
    expect(dataset!.items[0]).not.toHaveProperty('image_url');
    expect(dataset!.items[0]!.image_storage_path).toBe('p/a.jpg');
    expect(signedUrlsMock).not.toHaveBeenCalled();
  });

  it('prunes any over-returned second-wave rows to the dataset ids (defense-in-depth behind the .in scoping)', async () => {
    fetchAllRowsInvokesBuildPage();
    const { admin } = makeRecordingAdmin({
      inventory_items: { data: [baseItem], count: 1, error: null },
      item_stock_levels: {
        data: [
          { item_id: 'i1', location_id: 'L1', quantity: 2, locations: { name: '1-A', kind: 'rack' } },
          { item_id: 'FOREIGN', location_id: 'L9', quantity: 9, locations: { name: '9-Z', kind: 'rack' } },
        ],
        error: null,
      },
      item_images: {
        data: [
          { item_id: 'FOREIGN', storage_path: 'p/foreign.jpg', thumb_path: null, lqip: null, is_primary: true, sort_order: 0 },
          { item_id: 'i1', storage_path: 'p/own.jpg', thumb_path: null, lqip: null, is_primary: true, sort_order: 0 },
        ],
        error: null,
      },
    });
    createAdminClientMock.mockReturnValue(admin);

    const payload = await loadInventoryDataset('org-1', 'all', 'items');

    expect(Object.keys(payload!.placement)).toEqual(['i1']);
    expect(payload!.items[0]!.image_storage_path).toBe('p/own.jpg');
  });

  it('id-scopes the second wave with CHUNKED .in(item_id) calls (≤100 ids each — URL-length-safe) instead of org-wide fetches (rank 7: 50k-SKU orgs paid 50+ serial pages per table to serve ≤2000 items)', async () => {
    fetchAllRowsInvokesBuildPage();
    const manyItems = Array.from({ length: 205 }, (_, i) => ({
      ...baseItem,
      id: `i${String(i).padStart(3, '0')}`,
      sku: `SKU-${i}`,
    }));
    const { admin, buildersByTable } = makeRecordingAdmin({
      inventory_items: { data: manyItems, count: 205, error: null },
      item_stock_levels: { data: [], error: null },
      item_images: { data: [], error: null },
    });
    createAdminClientMock.mockReturnValue(admin);

    const payload = await loadInventoryDataset('org-1', 'all', 'items');
    expect(payload!.items).toHaveLength(205);

    // 205 ids → 3 chunks (100/100/5) per secondary table, EVERY chunk
    // id-scoped via .in AND still org-scoped (the admin client bypasses
    // RLS — the explicit org filter is the security contract).
    for (const table of ['item_stock_levels', 'item_images'] as const) {
      const builders = buildersByTable[table]!;
      expect(builders, `${table} must fan out one query per id chunk`).toHaveLength(3);
      const inCalls = builders.map(
        (b) => (b.in as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]],
      );
      expect(inCalls.map(([col]) => col)).toEqual(['item_id', 'item_id', 'item_id']);
      expect(inCalls.map(([, ids]) => ids.length)).toEqual([100, 100, 5]);
      expect(inCalls[0]![1][0]).toBe('i000');
      expect(inCalls[2]![1][4]).toBe('i204');
      for (const b of builders) {
        expect((b.eq as ReturnType<typeof vi.fn>).mock.calls).toEqual(
          expect.arrayContaining([['organization_id', 'org-1']]),
        );
      }
    }
  });

  it('over-cap view → resolves null WITHOUT fetching rows, and the cached fn THROWS (so "too large" — like null — is never cached)', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        inventory_items: { data: null, count: INSTANT_MODE_MAX_ROWS + 1, error: null },
      }),
    );

    await expect(loadInventoryDataset('org-1', 'all', 'items')).resolves.toBeNull();
    // The head count short-circuits before any row fetch.
    expect(fetchAllRows).not.toHaveBeenCalled();

    // THROW-DON'T-CACHE, verified at the seam: the fn handed to
    // unstable_cache must REJECT for the over-cap org — a returned null
    // would be written into the shared entry and served for a TTL.
    const datasetCall = vi
      .mocked(unstable_cache)
      .mock.calls.find(([, keyParts]) => (keyParts as string[])[0] === 'inventory-dataset-v1');
    expect(datasetCall).toBeDefined();
    const cachedFn = datasetCall![0] as (o: string, w: string, v: string) => Promise<unknown>;
    await expect(cachedFn('org-1', 'all', 'items')).rejects.toThrow(/INSTANT_MODE_MAX_ROWS/);
  });

  it('count-vs-fetch race (rows grew past the cap between the two queries) → null, never a truncated set', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        inventory_items: { data: null, count: 10, error: null },
      }),
    );
    vi.mocked(fetchAllRows).mockResolvedValueOnce(
      Array.from({ length: INSTANT_MODE_MAX_ROWS + 1 }, (_, i) => ({ ...baseItem, id: `i${i}` })) as never,
    );

    await expect(loadInventoryDataset('org-1', 'all', 'items')).resolves.toBeNull();
  });

  it('REAL query errors still throw (page falls back to server mode; nothing cached)', async () => {
    createAdminClientMock.mockReturnValue(
      makeAdmin({
        inventory_items: { data: null, count: null, error: { message: 'boom' } },
      }),
    );

    await expect(loadInventoryDataset('org-1', 'all', 'items')).rejects.toThrow(
      /count query failed: boom/,
    );
  });

  it('caches under the SAME org tag revalidateInventoryList expires, keyPart inventory-dataset-v1, 60s TTL (write-path invalidation covers instant mode with zero extra wiring)', async () => {
    fetchAllRowsInvokesBuildPage();
    createAdminClientMock.mockReturnValue(
      makeRecordingAdmin({
        inventory_items: { data: [], count: 0, error: null },
      }).admin,
    );

    await loadInventoryDataset('org-9', 'all', 'items');

    const call = vi
      .mocked(unstable_cache)
      .mock.calls.find(([, keyParts]) => (keyParts as string[])[0] === 'inventory-dataset-v1') as
      | [unknown, string[], { revalidate: number; tags: string[] }]
      | undefined;
    expect(call).toBeDefined();
    expect(call![2].tags).toEqual([inventoryListTag('org-9')]);
    expect(call![2].revalidate).toBe(60);
  });
});
