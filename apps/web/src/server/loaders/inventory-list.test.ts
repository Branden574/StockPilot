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

vi.mock('@/server/services/movements', () => ({
  getItemTrends: vi.fn(async () => new Map()),
}));

import { revalidateTag } from 'next/cache';

import { withContext } from '@/server/services/context';

import {
  inventoryListTag,
  isDefaultInventoryView,
  loadInventoryList,
  resolveInventoryListImages,
  revalidateInventoryList,
  revalidateInventoryListForCurrentOrg,
  type InventoryListCachedRow,
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
