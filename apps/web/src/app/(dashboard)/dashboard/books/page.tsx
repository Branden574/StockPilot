import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BookOpen } from 'lucide-react';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Books' };

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { BackfillCoversButton } from '@/components/books/backfill-covers-button';
import { RefreshBookPricesButton } from '@/components/inventory/refresh-book-prices-button';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { BooksInventoryTable } from '@/components/books/books-inventory-table';
import { RackFilterDropdown } from '@/components/inventory/rack-filter-dropdown';
import { TableBodySkeleton } from '@/components/dashboard/skeletons';
import { Button } from '@/components/ui/button';
import { can } from '@stockpilot/core';
import {
  deriveInstantView,
  instantStateFromPageParams,
} from '@/lib/inventory/instant-mode';
import {
  ALL_WAREHOUSES_KEY,
  canUseSharedInventoryCaches,
  deriveInventoryTrends,
  isDefaultInventoryView,
  loadInventoryDataset,
  loadInventoryList,
  loadInventoryLookups,
  loadInventoryTrendBuckets,
  resolveInventoryListImages,
  type InventoryListItemRow,
  type InventoryListLookups,
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

// Lowered 50 → 30 in line with the inventory page. Book covers
// average noticeably larger than item thumbnails (more variety of
// remote sources, less cached on Vercel's image optimizer), so the
// load-weight savings are even more pronounced here.
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

type BooksSearchParams = {
  q?: string;
  status?: string;
  stock?: string;
  /** '1' narrows the Archived view to system-archived rows only (Task 8's
   *  "Auto-archived only" filter chip). */
  auto?: string;
  /** '1' = the "Expected" chip view (mig 0277): ONLY books auto-created
   *  from inbound POs that have never received stock. The default view
   *  excludes those rows entirely. */
  expected?: string;
  page?: string;
  sort?: string;
  cat?: string | string[];
  loc?: string | string[];
  charter?: string | string[];
  rack?: string;
};

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<BooksSearchParams>;
}) {
  const moduleAccess = await checkModuleAccess('books');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="books" canManage={moduleAccess.canManage} />;
  }
  // Phase 6: gate the bulk price-refresh action on the optional
  // price_tracking module. When OFF, the button never renders and the
  // page is identical to before.
  const { enabled: priceTrackingEnabled } = await checkModuleAccess('price_tracking');
  const params = await searchParams;

  const lifecycleStatus =
    params.status === 'archived' ||
    params.status === 'discontinued' ||
    params.status === 'all' ||
    params.status === 'active'
      ? params.status
      : 'active';

  // Chrome-only dependencies: the request-cached auth context (fast — already
  // resolved by the dashboard layout) gates the create/import buttons, and the
  // rack list feeds the toolbar dropdown. The heavy book list + trends + covers
  // stream behind <Suspense> below. The heading inherits a per-org nav rename
  // (Settings → Navigation) off the request-cached org row — no extra fetch.
  // The racks RPC is CHAINED INSIDE the Promise.all (not awaited after it)
  // so the toolbar chrome never waits an extra sequential DB round trip —
  // same fix as the Items page (cold-start plan rank 2). withContext is
  // request-cached, so the chain adds no duplicate auth work.
  const [sessionCtx, heading, racks] = await Promise.all([
    requireOrgContext(),
    effectiveNavLabel('/dashboard/books', 'Books'),
    InventoryService.forCurrentUser().then((svc) =>
      svc.listDistinctRacks({ scope: 'books' }),
    ),
  ]);

  const canCreate = can(sessionCtx, 'items:create');
  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {lifecycleStatus === 'archived'
              ? 'Books you archived. Restore one by editing it and setting status to Active.'
              : 'Books are tracked separately here but still count toward total inventory value, low stock, and out of stock on the overview.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Same status-param toggle the Inventory page uses; books
              accept the same lifecycleStatus filter. */}
          <ArchiveViewToggle
            paramName="status"
            view={lifecycleStatus === 'archived' ? 'archived' : 'active'}
          />
          <RackFilterDropdown racks={racks} />
          {canCreate && lifecycleStatus !== 'archived' && (
            <>
              <BackfillCoversButton />
              {priceTrackingEnabled && <RefreshBookPricesButton />}
              <Button asChild variant="outline">
                <Link href="/dashboard/books/import">Bulk ISBN import</Link>
              </Button>
              <Button asChild variant="gradient">
                <Link href="/dashboard/books/new">+ New book</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-8">
        <Suspense fallback={<TableBodySkeleton rows={10} />}>
          <BooksTableSection params={params} lifecycleStatus={lifecycleStatus} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * Inner async Server Component: the awaited data fetch (book list + per-row
 * trends/covers + filter lookups) lives here so the page shell above paints
 * the chrome immediately and only the table body streams. Same components,
 * same props as before — purely relocated behind <Suspense>.
 */
/**
 * Data both acquisition paths (cached default view / live filtered
 * view) normalize into before the shared render tail below.
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
  /** ACTIVE books awaiting first receipt (mig 0277) — the "Expected"
   *  chip's count badge (server mode; instant mode derives locally). */
  expectedCount: number;
};

async function BooksTableSection({
  params,
  lifecycleStatus,
}: {
  params: BooksSearchParams;
  lifecycleStatus: 'archived' | 'discontinued' | 'all' | 'active';
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const [sessionCtx, warehouseFilter, savedViewsSvc] = await Promise.all([
    requireOrgContext(),
    getActiveWarehouseFilter(),
    SavedViewsService.forCurrentUser(),
  ]);
  // Saved views are strictly per-user — they never enter the shared
  // cache. Kick the query off now so it overlaps either data path.
  const savedViewsPromise = savedViewsSvc.list('books');
  // Keep the rejection observed even if the data path throws before the
  // await below — an unobserved rejection would crash the lambda.
  savedViewsPromise.catch(() => {});

  let data: SectionData | null = null;

  // ONE role-class gate for every org-shared cache read on this page —
  // the full default-view payload below AND the filtered views' lookup/
  // trend reuse further down. Staff/viewer are user-scoped and NEVER
  // read a shared cache.
  const useSharedCaches = canUseSharedInventoryCaches(sessionCtx);

  const canCreate = can(sessionCtx, 'items:create');
  // Public-catalog visibility (P3): spec requires books get the identical
  // bulk "Set public visibility" action; the server action re-asserts.
  const canSetPublicVisibility = can(sessionCtx, 'public_links:manage');

  // INSTANT MODE — same contract as the Items page: manager+ orgs at or
  // under INSTANT_MODE_MAX_ROWS get the FULL Books dataset and the
  // table derives search/filter/sort/status/stock/pagination locally
  // (zero server round trips; shallow URL sync). Deep links still
  // server-render correctly — the same pure derivation runs here for
  // the empty-state branches and in the table's SSR pass. Staff/viewer,
  // over-cap orgs (dataset === null) and loader failures fall through
  // byte-identical to today. (Books never split placement rows, so no
  // placement is passed.)
  let instantData: {
    items: InventoryListItemRow[];
    lookups: InventoryListLookups;
    trends: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  } | null = null;
  if (useSharedCaches) {
    // Data acquisition only in here — the JSX renders after the
    // try/catch (react-hooks/error-boundaries). Any failure →
    // instantData stays null → the server path below runs unchanged.
    try {
      const [dataset, lookups, trendBuckets] = await Promise.all([
        loadInventoryDataset(
          sessionCtx.organizationId,
          warehouseFilter ?? ALL_WAREHOUSES_KEY,
          'books',
        ),
        loadInventoryLookups(sessionCtx.organizationId),
        loadInventoryTrendBuckets(sessionCtx.organizationId),
      ]);
      if (dataset) {
        // Paths → signed URLs per request, through the same shared
        // 25-day per-path cache as every other list surface.
        const items = await resolveInventoryListImages(sessionCtx.organizationId, dataset.items);
        instantData = {
          items,
          lookups,
          // Full-dataset trends from the org-wide buckets — pure CPU.
          trends: deriveInventoryTrends(
            items.map((i) => ({ id: i.id, quantityOnHand: i.quantity_on_hand })),
            trendBuckets,
          ),
        };
      }
    } catch (err) {
      console.warn('[books page] instant dataset unavailable, using server mode:', err);
    }
  }

  if (instantData) {
    const savedViews = await savedViewsPromise;
    const { items: instantItems, lookups } = instantData;
    const derived = deriveInstantView(
      instantItems,
      instantStateFromPageParams(params),
      'books',
      PAGE_SIZE,
    );
    const emptyState = booksEmptyState({
      total: derived.total,
      params,
      lifecycleStatus,
      canCreate,
    });
    if (emptyState) return emptyState;
    return (
      <BooksInventoryTable
        items={instantItems}
        total={derived.total}
        valueOnHand={derived.valueOnHand}
        lookups={{
          categories: new Map(
            lookups.categories.map((c) => [c.id, { name: c.name, color: c.color }]),
          ),
          locations: new Map(lookups.locations.map((l) => [l.id, { name: l.name }])),
          charters: new Map(lookups.charters.map((c) => [c.id, { name: c.name, code: c.code }])),
        }}
        canCreate={canCreate}
        canSetPublicVisibility={canSetPublicVisibility}
        categories={lookups.categories.map((c) => ({ id: c.id, name: c.name }))}
        locations={lookups.locations}
        charters={lookups.charters}
        suppliers={lookups.suppliers}
        tags={lookups.tags}
        initialQuery={params.q}
        rowLinkPrefix="/dashboard/books"
        basePath="/dashboard/books"
        showBookFields
        page={derived.page}
        pageSize={PAGE_SIZE}
        trends={instantData.trends}
        savedViews={savedViews}
        savedViewScope="books"
        activeWarehouseId={warehouseFilter}
        currentUserId={sessionCtx.userId}
        instant={{ items: instantItems, view: 'books' }}
      />
    );
  }

  // COLD-CLICK FAST PATH — same contract as the Items page: only the
  // exact default view, keyed by the warehouse-filter cookie. Any
  // loader failure falls through to the live path. (The 'books' module
  // gate already ran in the page shell above.)
  if (isDefaultInventoryView(params, 'books') && useSharedCaches) {
    try {
      const payload = await loadInventoryList(
        sessionCtx.organizationId,
        warehouseFilter ?? ALL_WAREHOUSES_KEY,
        'books',
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
        expectedCount: payload.expectedCount,
      };
    } catch (err) {
      console.warn('[books page] cached default view unavailable, using live path:', err);
    }
  }

  if (!data) {
    // LIVE (filtered) branch — same hybrid as the Items page: rows +
    // covers always live; for manager+ with items:read the lookup
    // tables and org-wide trend buckets come from the org-shared
    // caches. valueOnHand stays live (list()'s footer sum mirrors the
    // active filters, computed in parallel with the rows query).
    // Staff/viewer run everything live through their RLS-scoped
    // clients, exactly as before.
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
        categoriesSvc.list(),
        locationsSvc.list({ sitesOnly: true }),
        suppliersSvc.list(),
        tagsSvc.list(),
        chartersSvc.list(),
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

    const [inventory, expectedCountLive, lookups, trendBuckets] = await Promise.all([
      inventorySvc.list({
        q: params.q,
        status: lifecycleStatus,
        lowStock: params.stock === 'low',
        outOfStock: params.stock === 'out',
        autoArchived: params.auto === '1',
        expected: params.expected === '1',
        warehouseId: warehouseFilter,
        itemType: 'book',
        categoryIds,
        locationIds,
        charterIds,
        rack,
        sort,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
      // Expected-chip badge count (mig 0277) — one HEAD count on the
      // 0277 partial index, in parallel with the rows query. NEVER
      // fails the page: the chip degrades to hidden on error.
      inventorySvc
        .countExpected({ itemType: 'book', warehouseId: warehouseFilter })
        .catch(() => 0),
      useSharedCaches
        ? loadInventoryLookups(sessionCtx.organizationId).catch((err: unknown) => {
            console.warn('[books page] cached lookups unavailable, using live path:', err);
            return fetchLiveLookups();
          })
        : fetchLiveLookups(),
      useSharedCaches
        ? loadInventoryTrendBuckets(sessionCtx.organizationId).catch((err: unknown) => {
            console.warn('[books page] cached trend buckets unavailable, using live path:', err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    // Trends + primary images are independent — run in parallel.
    // trends: 14-day sparkline series — pure CPU when the shared
    //   buckets are warm (deriveInventoryTrends, same math as
    //   getItemTrends); otherwise 1 round trip, exactly as before.
    // imagesById: signed URLs (master + 200px thumb when available) +
    //   inline LQIP base64. Pre-0122 rows render the master with no
    //   blur placeholder via the fallbacks below.
    const trendInputs = inventory.items.map((i) => ({
      id: i.id,
      quantityOnHand: i.quantity_on_hand,
    }));
    const [trends, imagesById] = await Promise.all([
      trendBuckets
        ? Promise.resolve(deriveInventoryTrends(trendInputs, trendBuckets))
        : getItemTrends(trendInputs),
      imagesSvc.primaryImagesWithThumbsForItems(inventory.items.map((i) => i.id)),
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
        image_url: img?.url ?? cfThumb ?? null,
        image_thumb_url: img?.thumbUrl ?? null,
        image_lqip: img?.lqip ?? null,
      };
    });

    data = {
      items: itemsWithImages,
      total: inventory.total,
      valueOnHand: inventory.valueOnHand,
      ...lookups,
      trends,
      expectedCount: expectedCountLive,
    };
  }

  const savedViews = await savedViewsPromise;
  const itemsWithImages = data.items;

  const lookups = {
    categories: new Map(
      data.categories.map((c) => [c.id, { name: c.name, color: c.color }]),
    ),
    locations: new Map(data.locations.map((l) => [l.id, { name: l.name }])),
    charters: new Map(
      data.charters.map((c) => [c.id, { name: c.name, code: c.code }]),
    ),
  };

  const emptyState = booksEmptyState({
    total: data.total,
    params,
    lifecycleStatus,
    canCreate,
  });
  if (emptyState) return emptyState;

  return (
    <BooksInventoryTable
      items={itemsWithImages}
      total={data.total}
      valueOnHand={data.valueOnHand}
      lookups={lookups}
      canCreate={canCreate}
      canSetPublicVisibility={canSetPublicVisibility}
      categories={data.categories.map((c) => ({ id: c.id, name: c.name }))}
      locations={data.locations}
      charters={data.charters}
      suppliers={data.suppliers}
      tags={data.tags}
      initialQuery={params.q}
      rowLinkPrefix="/dashboard/books"
      basePath="/dashboard/books"
      showBookFields
      page={page}
      pageSize={PAGE_SIZE}
      trends={data.trends}
      savedViews={savedViews}
      savedViewScope="books"
      activeWarehouseId={warehouseFilter}
      currentUserId={sessionCtx.userId}
      expectedCount={data.expectedCount}
    />
  );
}

/**
 * The rich zero-result EmptyStates, shared VERBATIM by the instant and
 * server branches (extracted, not duplicated, so the two modes can't
 * drift). Returns null when the table should render.
 */
function booksEmptyState({
  total,
  params,
  lifecycleStatus,
  canCreate,
}: {
  total: number;
  params: BooksSearchParams;
  lifecycleStatus: 'archived' | 'discontinued' | 'all' | 'active';
  canCreate: boolean;
}) {
  if (total !== 0) return null;
  // Expected chip view (mig 0277) with zero rows — same dedicated branch
  // as the Items page so the generic "No books yet" CTA never fires here.
  if (params.expected === '1' && !params.q && !params.stock) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No expected books"
        description="Books created from purchase orders appear here until their first stock is received."
        cta={{ label: 'Back to all books', href: '/dashboard/books' }}
      />
    );
  }
  // Excludes ?auto=1 (the "Auto-archived only" chip) — same rationale as
  // the Items page: a zero result there just means none of the archived
  // books were system-archived, not that nothing is archived at all.
  if (lifecycleStatus === 'archived' && !params.q && !params.stock && params.auto !== '1') {
    return (
      <EmptyState
        icon={BookOpen}
        title="No archived books"
        description="Nothing here yet. Books you archive will show up in this view."
        cta={{ label: 'Back to active books', href: '/dashboard/books' }}
      />
    );
  }
  if (!params.q && !params.stock) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No books yet"
        description={
          canCreate
            ? 'Add your first book — title, ISBN, author, quantity. Books roll up into the same dashboard totals as regular items.'
            : 'No books have been added to this workspace yet.'
        }
        cta={
          canCreate
            ? { label: 'Add your first book', href: '/dashboard/books/new' }
            : undefined
        }
      />
    );
  }
  if (params.stock === 'low') {
    return (
      <EmptyState
        icon={BookOpen}
        title="No low-stock books"
        description="No books are at or below their reorder point right now. Clear the filter to see all books."
        cta={{ label: 'Show all books', href: '/dashboard/books' }}
      />
    );
  }
  if (params.stock === 'out') {
    return (
      <EmptyState
        icon={BookOpen}
        title="No out-of-stock books"
        description="Nothing is at zero quantity right now. Clear the filter to see all books."
        cta={{ label: 'Show all books', href: '/dashboard/books' }}
      />
    );
  }
  return null;
}
