import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Boxes } from 'lucide-react';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Inventory' };

import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { RackFilterDropdown } from '@/components/inventory/rack-filter-dropdown';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { Button } from '@/components/ui/button';
import { can } from '@stockpilot/core';
import {
  ALL_WAREHOUSES_KEY,
  canUseSharedInventoryCaches,
  deriveInventoryTrends,
  isDefaultInventoryView,
  loadInventoryList,
  loadInventoryLookups,
  loadInventoryTrendBuckets,
  resolveInventoryListImages,
  type InventoryListItemRow,
  type InventoryListLookups,
  type InventoryPlacementLine,
} from '@/server/loaders/inventory-list';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { getItemTrends } from '@/server/services/movements';
import { SavedViewsService } from '@/server/services/saved-views';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { requireOrgContext } from '@/lib/auth/session';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

// Dropped from 50 → 30 after the Playwright speed sweep showed the
// inventory list pulling ~3 MB and 6.2s to load on a warm cache. The
// DB query + row render + per-row image fetch all scale ~linearly
// with page size; 30 keeps a useful density for power users while
// shaving roughly 40% off load weight. Pagination still serves users
// who need to scan further.
const PAGE_SIZE = 30;

type SortParam =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'created_desc'
  | 'created_asc';

const VALID_SORTS = new Set<SortParam>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

function parseSort(value: string | undefined): SortParam {
  return value && VALID_SORTS.has(value as SortParam) ? (value as SortParam) : 'updated_desc';
}

function parseIdList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

type InventorySearchParams = {
  q?: string;
  status?: string;
  stock?: string;
  type?: string;
  page?: string;
  sort?: string;
  cat?: string | string[];
  loc?: string | string[];
  charter?: string | string[];
  rack?: string;
};

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<InventorySearchParams>;
}) {
  const params = await searchParams;

  const lifecycleStatus =
    params.status === 'archived' ||
    params.status === 'discontinued' ||
    params.status === 'all' ||
    params.status === 'active'
      ? params.status
      : 'active';

  // Default Items tab is products only; pass ?type=all|book|asset|consumable
  // to widen. The dashboard's "Review low stock" link uses ?type=all so the
  // user sees every low-stock row regardless of item_type.
  const itemType =
    params.type === 'all' ||
    params.type === 'book' ||
    params.type === 'asset' ||
    params.type === 'consumable' ||
    params.type === 'product'
      ? params.type
      : 'product';
  const showingAllTypes = itemType === 'all';

  // When the page is showing every item type (?type=all) we need the
  // rack dropdown to include both items-scope and books-scope racks so
  // the deep-link from the dashboard's all-types view doesn't show a
  // partial list. Otherwise we stick to the items scope.
  const rackScope: 'items' | 'books' | 'all' = itemType === 'all' ? 'all' : 'items';

  // Chrome-only dependencies: the request-cached auth context (fast — the
  // dashboard layout already resolved it) gates the create/import buttons,
  // and the rack list feeds the toolbar dropdown. Both are needed to paint
  // the toolbar synchronously; the heavy item list + trends + images stream
  // behind <Suspense> below. The heading inherits a per-org nav rename
  // (Settings → Navigation) off the request-cached org row — no extra fetch.
  const [sessionCtx, inventorySvc, heading] = await Promise.all([
    requireOrgContext(),
    InventoryService.forCurrentUser(),
    effectiveNavLabel('/dashboard/inventory', 'Inventory'),
  ]);
  const racks = await inventorySvc.listDistinctRacks({ scope: rackScope });

  // Gate the create / import buttons on `items:create`. Viewers (read-
  // only role) and stock-adjust-only roles should NOT see entry points
  // for new items — the underlying page action also enforces this, but
  // hiding the button is the user-facing fix.
  const canCreate = can(sessionCtx, 'items:create');

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {lifecycleStatus === 'archived'
              ? 'Items you archived. Restore one by editing it and setting status to Active.'
              : showingAllTypes
                ? 'Showing every item type — products, books, assets, consumables.'
                : 'Items, SKUs, stock levels — searchable and sortable.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Inventory pages use ?status=active|archived|discontinued|all
              (not ?view=); the toggle reads/writes that param so saved
              views + deep links keep their existing shape. */}
          <ArchiveViewToggle
            paramName="status"
            view={lifecycleStatus === 'archived' ? 'archived' : 'active'}
          />
          <RackFilterDropdown racks={racks} />
          {canCreate && lifecycleStatus !== 'archived' && (
            <>
              <Button asChild variant="outline">
                <Link href="/dashboard/inventory/import">Import CSV</Link>
              </Button>
              <Button asChild variant="gradient">
                <Link href="/dashboard/inventory/new">+ New item</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-8">
        <Suspense fallback={<TableBodySkeleton rows={10} />}>
          <InventoryTableSection params={params} lifecycleStatus={lifecycleStatus} itemType={itemType} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * Inner async Server Component: the awaited data fetch (item list + per-row
 * trends/images + filter lookups) lives here so the page shell above paints
 * the chrome immediately and only the table body streams. Same components,
 * same props as before — purely relocated behind <Suspense>.
 */
/**
 * Data both acquisition paths (cached default view / live filtered
 * view) normalize into before the shared render tail below. The item
 * rows carry the same columns either way — the loader's row type
 * mirrors InventoryService.list()'s select verbatim.
 */
type SectionData = {
  items: InventoryListItemRow[];
  total: number;
  valueOnHand: number;
  categories: Array<{ id: string; name: string; color: string | null }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string | null }>;
  charters: Array<{ id: string; name: string; code: string | null }>;
  trends: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  placementMap: Map<string, InventoryPlacementLine[]>;
};

async function InventoryTableSection({
  params,
  lifecycleStatus,
  itemType,
}: {
  params: InventorySearchParams;
  lifecycleStatus: 'archived' | 'discontinued' | 'all' | 'active';
  itemType: 'all' | 'book' | 'asset' | 'consumable' | 'product';
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const [sessionCtx, warehouseFilter, savedViewsSvc] = await Promise.all([
    requireOrgContext(),
    getActiveWarehouseFilter(),
    SavedViewsService.forCurrentUser(),
  ]);
  // Saved views are strictly per-user — they never enter the shared
  // cache. Kick the query off now so it overlaps either data path.
  const savedViewsPromise = savedViewsSvc.list('inventory');
  // Keep the rejection observed even if the data path throws before the
  // await below — an unobserved rejection would crash the lambda.
  savedViewsPromise.catch(() => {});

  // Wrap each query so a single failure surfaces with its tag in Vercel
  // logs instead of the generic "Server Components render" error
  // message that omits details in production. Each promise stays in
  // Promise.all so the page parallelism is preserved.
  function tagged<T>(label: string, p: Promise<T>): Promise<T> {
    return p.catch((err) => {
      console.error(`[inventory page] ${label} failed:`, err);
      throw err;
    });
  }

  let data: SectionData | null = null;

  // ONE role-class gate for every org-shared cache read on this page —
  // the full default-view payload below AND the filtered views' lookup/
  // trend reuse further down. Staff/viewer are user-scoped (warehouse
  // assignments / category restrictions) and NEVER read a shared cache;
  // can(items:read) keeps a permission revocation from outliving the
  // cache the way raw RLS rows would not.
  const useSharedCaches = canUseSharedInventoryCaches(sessionCtx);

  // COLD-CLICK FAST PATH: the exact default view (page 1, default sort,
  // no search/filters) is served from an org-keyed 60s cache that the
  // prewarm cron keeps warm. isDefaultInventoryView is mandatory — any
  // data-affecting param takes the live path unchanged. The warehouse-
  // filter cookie changes the data, so it's part of the cache key. A
  // loader failure falls through to the live path.
  if (isDefaultInventoryView(params, 'items') && useSharedCaches) {
    try {
      const payload = await loadInventoryList(
        sessionCtx.organizationId,
        warehouseFilter ?? ALL_WAREHOUSES_KEY,
        'items',
      );
      data = {
        // Cached rows carry image PATHS; the signed URLs are resolved
        // per request through the shared 25-day per-path cache (never
        // inside the loader's cache — see the loader's header note).
        items: await resolveInventoryListImages(sessionCtx.organizationId, payload.items),
        total: payload.total,
        valueOnHand: payload.valueOnHand,
        categories: payload.categories,
        locations: payload.locations,
        suppliers: payload.suppliers,
        tags: payload.tags,
        charters: payload.charters,
        trends: new Map(Object.entries(payload.trends)),
        placementMap: new Map(Object.entries(payload.placement)),
      };
    } catch (err) {
      console.warn('[inventory page] cached default view unavailable, using live path:', err);
    }
  }

  if (!data) {
    // LIVE (filtered) branch. Only rows + placement + images actually
    // vary with the filters, so for manager+ with items:read (the SAME
    // gate as the cached default view) the filter-independent pieces —
    // the five lookup tables and the org-wide trend buckets — are read
    // from the org-shared caches instead of re-queried live. valueOnHand
    // deliberately stays live: list()'s footer sum mirrors the active
    // filters (and runs in parallel with the rows query — no serial
    // cost). Staff/viewer run EVERYTHING live through their RLS-scoped
    // clients, exactly as before — useSharedCaches is false for them,
    // so no cached branch below is reachable.
    const [inventorySvc, imagesSvc] = await Promise.all([
      InventoryService.forCurrentUser(),
      ItemImagesService.forCurrentUser(),
    ]);

    const sort = parseSort(params.sort);
    const categoryIds = parseIdList(params.cat);
    const locationIds = parseIdList(params.loc);
    const charterIds = parseIdList(params.charter);
    const rack = typeof params.rack === 'string' ? params.rack : undefined;

    // Live lookups: the path staff/viewer ALWAYS take (identical
    // queries + mapping to the pre-split code), and the fallback for
    // manager+ when a shared-cache read fails.
    const fetchLiveLookups = async (): Promise<InventoryListLookups> => {
      const [categoriesSvc, locationsSvc, suppliersSvc, tagsSvc, chartersSvc] = await Promise.all([
        CategoriesService.forCurrentUser(),
        LocationsService.forCurrentUser(),
        SuppliersService.forCurrentUser(),
        TagsService.forCurrentUser(),
        ChartersService.forCurrentUser(),
      ]);
      const [categories, locations, suppliers, tags, charters] = await Promise.all([
        tagged('categoriesSvc.list', categoriesSvc.list()),
        tagged('locationsSvc.list', locationsSvc.list({ sitesOnly: true })),
        tagged('suppliersSvc.list', suppliersSvc.list()),
        tagged('tagsSvc.list', tagsSvc.list()),
        tagged('chartersSvc.list', chartersSvc.list()),
      ]);
      return {
        categories: categories.map((c) => ({
          id: c.id as string,
          name: c.name as string,
          color: (c.color as string | null) ?? null,
        })),
        locations: locations.map((l) => ({ id: l.id as string, name: l.name as string })),
        suppliers: suppliers.map((s) => ({ id: s.id as string, name: s.name as string })),
        tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        charters: charters.map((c) => ({ id: c.id, name: c.name, code: c.code ?? null })),
      };
    };

    const [inventory, lookups, trendBuckets] = await Promise.all([
      tagged(
        'inventorySvc.list',
        inventorySvc.list({
          q: params.q,
          status: lifecycleStatus,
          lowStock: params.stock === 'low',
          outOfStock: params.stock === 'out',
          itemType,
          warehouseId: warehouseFilter,
          categoryIds,
          locationIds,
          charterIds,
          rack,
          sort,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
      ),
      useSharedCaches
        ? loadInventoryLookups(sessionCtx.organizationId).catch((err: unknown) => {
            console.warn('[inventory page] cached lookups unavailable, using live path:', err);
            return fetchLiveLookups();
          })
        : fetchLiveLookups(),
      useSharedCaches
        ? loadInventoryTrendBuckets(sessionCtx.organizationId).catch((err: unknown) => {
            console.warn(
              '[inventory page] cached trend buckets unavailable, using live path:',
              err,
            );
            return null;
          })
        : Promise.resolve(null),
    ]);

    // Per-row trends + primary images both depend on the resolved item
    // list, but they're independent of each other — run them in parallel.
    //   trends    → 14-day sparkline data. With warm shared buckets this
    //               is pure CPU (deriveInventoryTrends — the same math
    //               getItemTrends runs); otherwise 1 round trip via
    //               stock_movements, exactly as before.
    //   imagesById → primary photo signed URL per item (1 select + 1 batch
    //                createSignedUrls; falls back to custom_fields.thumbnail_url
    //                stashed by the bulk-ISBN importer for legacy books).
    const itemIdList = inventory.items.map((i) => i.id);
    const trendInputs = inventory.items.map((i) => ({
      id: i.id,
      quantityOnHand: i.quantity_on_hand,
    }));
    const [trends, imagesById, placementMap] = await Promise.all([
      trendBuckets
        ? Promise.resolve(deriveInventoryTrends(trendInputs, trendBuckets))
        : tagged('getItemTrends', getItemTrends(trendInputs)),
      tagged(
        'imagesSvc.primaryImagesWithThumbsForItems',
        // Richer shape than primaryImagesForItems — also returns the
        // 200px thumb signed URL (when the row has one — 0122 onward)
        // and the inline LQIP base64 for next/image's blurDataURL.
        imagesSvc.primaryImagesWithThumbsForItems(itemIdList),
      ),
      // Per-(item, location) holdings so the list shows ONE LINE PER RACK.
      tagged('inventorySvc.placementBreakdown', inventorySvc.placementBreakdown(itemIdList)),
    ]);
    const itemsWithImages = inventory.items.map((i) => {
      const cf = (i as { custom_fields?: Record<string, unknown> | null })
        .custom_fields;
      const cfThumb =
        cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
          ? (cf.thumbnail_url as string)
          : null;
      const img = imagesById.get(i.id);
      return {
        ...i,
        // master URL (hover preview prefetch + lightbox still use this)
        image_url: img?.url ?? cfThumb ?? null,
        // pre-resized 200px thumb URL when available; rows pre-dating
        // 0122 fall back to image_url at the rendering site.
        image_thumb_url: img?.thumbUrl ?? null,
        // base64 LQIP for next/image's blurDataURL; null pre-0122.
        image_lqip: img?.lqip ?? null,
      };
    });

    data = {
      items: itemsWithImages,
      total: inventory.total,
      valueOnHand: inventory.valueOnHand,
      ...lookups,
      trends,
      placementMap,
    };
  }

  const savedViews = await savedViewsPromise;
  const itemsWithImages = data.items;
  const placementMap = data.placementMap;

  // ONE LINE PER RACK: expand each item into a row per holding location. The
  // Chromebook placed 250→1-A and 250→2-C becomes two rows. `line_quantity` is
  // that rack's qty (shown in ON HAND); `quantity_on_hand` is left as the item
  // TOTAL so status/coverage/sparkline stay item-level and the value footer
  // (server-computed) isn't double-counted. Items with no holdings fall back to
  // a single row at their own on-hand. Single-location items stay one row.
  const placementRows = itemsWithImages.flatMap((item) => {
    const ps = placementMap.get(item.id) ?? [];
    // Both branches return the SAME row shape (same keys + property types) so
    // the result is a single uniform array, not a union.
    if (ps.length === 0) {
      return [
        {
          ...item,
          rowKey: item.id,
          line_quantity: item.quantity_on_hand,
          placement_label: null as string | null,
          placement_kind: undefined as string | undefined,
        },
      ];
    }
    return ps.map((p) => ({
      ...item,
      rowKey: `${item.id}:${p.locationId}`,
      line_quantity: p.quantity,
      placement_label: p.label as string | null,
      placement_kind: p.kind as string | undefined,
    }));
  });

  const lookups = {
    categories: new Map(
      data.categories.map((c) => [c.id, { name: c.name, color: c.color }]),
    ),
    locations: new Map(data.locations.map((l) => [l.id, { name: l.name }])),
    charters: new Map(
      data.charters.map((c) => [c.id, { name: c.name, code: c.code }]),
    ),
  };

  const canCreate = can(sessionCtx, 'items:create');

  if (data.total === 0 && lifecycleStatus === 'archived' && !params.q && !params.stock) {
    return (
      <EmptyState
        icon={Boxes}
        title="No archived items"
        description="Nothing here yet. Items you archive will show up in this view."
        cta={{ label: 'Back to active items', href: '/dashboard/inventory' }}
      />
    );
  }
  if (data.total === 0 && !params.q && !params.stock) {
    return (
      <EmptyState
        icon={Boxes}
        title="No items yet"
        description={
          canCreate
            ? 'Add your first item to start tracking stock, locations, and movements.'
            : 'No items have been added to this workspace yet.'
        }
        cta={
          canCreate
            ? { label: 'Add your first item', href: '/dashboard/inventory/new' }
            : undefined
        }
      />
    );
  }
  if (data.total === 0 && params.stock === 'low') {
    return (
      <EmptyState
        icon={Boxes}
        title="No low-stock items"
        description="Nothing is at or below its reorder point right now. Nice."
        cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
      />
    );
  }
  if (data.total === 0 && params.stock === 'out') {
    return (
      <EmptyState
        icon={Boxes}
        title="Nothing is out of stock"
        description="No active items have a quantity of zero. Clear the filter to see all items."
        cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
      />
    );
  }
  if (data.total === 0 && params.q) {
    // Search returned zero results. Without this branch the page
    // fell through to InventoryTable rendering a single bare cell
    // ("No items match your filters.") — the only empty state on
    // the page that wasn't using the rich <EmptyState> component.
    return (
      <EmptyState
        icon={Boxes}
        title="No items match your search"
        description={`Nothing matched "${params.q.slice(0, 40)}". Try a different SKU, name, or barcode.`}
        cta={{ label: 'Clear search', href: '/dashboard/inventory' }}
      />
    );
  }

  return (
    <InventoryTable
      items={placementRows}
      total={data.total}
      valueOnHand={data.valueOnHand}
      lookups={lookups}
      canCreate={canCreate}
      categories={data.categories.map((c) => ({ id: c.id, name: c.name }))}
      locations={data.locations}
      charters={data.charters}
      suppliers={data.suppliers}
      tags={data.tags}
      initialQuery={params.q}
      page={page}
      pageSize={PAGE_SIZE}
      trends={data.trends}
      savedViews={savedViews}
      savedViewScope="inventory"
      activeWarehouseId={warehouseFilter}
      currentUserId={sessionCtx.userId}
    />
  );
}
