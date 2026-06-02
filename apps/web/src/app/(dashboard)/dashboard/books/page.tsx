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
import { hasPermission } from '@stockpilot/core';
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
  // stream behind <Suspense> below.
  const [sessionCtx, inventorySvc] = await Promise.all([
    requireOrgContext(),
    InventoryService.forCurrentUser(),
  ]);
  const racks = await inventorySvc.listDistinctRacks({ scope: 'books' });

  const canCreate = hasPermission(sessionCtx.role, 'items:create');
  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
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
async function BooksTableSection({
  params,
  lifecycleStatus,
}: {
  params: BooksSearchParams;
  lifecycleStatus: 'archived' | 'discontinued' | 'all' | 'active';
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const [inventorySvc, categoriesSvc, locationsSvc, suppliersSvc, tagsSvc, chartersSvc, imagesSvc, savedViewsSvc, warehouseFilter, sessionCtx] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    ItemImagesService.forCurrentUser(),
    SavedViewsService.forCurrentUser(),
    getActiveWarehouseFilter(),
    requireOrgContext(),
  ]);

  const sort = parseSort(params.sort);
  const categoryIds = parseIdList(params.cat);
  const locationIds = parseIdList(params.loc);
  const charterIds = parseIdList(params.charter);
  const rack = typeof params.rack === 'string' ? params.rack : undefined;

  const [inventory, categories, locations, suppliers, tags, charters, savedViews] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: lifecycleStatus,
      lowStock: params.stock === 'low',
      outOfStock: params.stock === 'out',
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
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    tagsSvc.list(),
    chartersSvc.list(),
    savedViewsSvc.list('books'),
  ]);

  // Trends + primary images are independent — run in parallel.
  // trends: 14-day sparkline series.
  // imagesById: signed URLs (master + 200px thumb when available) +
  //   inline LQIP base64. Pre-0122 rows render the master with no
  //   blur placeholder via the fallbacks below.
  const [trends, imagesById] = await Promise.all([
    getItemTrends(
      inventory.items.map((i) => ({ id: i.id, quantityOnHand: i.quantity_on_hand })),
    ),
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

  const lookups = {
    categories: new Map(
      categories.map((c) => [
        c.id as string,
        { name: c.name as string, color: (c.color as string | null) ?? null },
      ]),
    ),
    locations: new Map(locations.map((l) => [l.id as string, { name: l.name as string }])),
    charters: new Map(
      charters.map((c) => [c.id, { name: c.name, code: c.code ?? null }]),
    ),
  };

  if (inventory.total === 0 && lifecycleStatus === 'archived' && !params.q && !params.stock) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No archived books"
        description="Nothing here yet. Books you archive will show up in this view."
        cta={{ label: 'Back to active books', href: '/dashboard/books' }}
      />
    );
  }
  if (inventory.total === 0 && !params.q && !params.stock) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No books yet"
        description={
          hasPermission(sessionCtx.role, 'items:create')
            ? 'Add your first book — title, ISBN, author, quantity. Books roll up into the same dashboard totals as regular items.'
            : 'No books have been added to this workspace yet.'
        }
        cta={
          hasPermission(sessionCtx.role, 'items:create')
            ? { label: 'Add your first book', href: '/dashboard/books/new' }
            : undefined
        }
      />
    );
  }
  if (inventory.total === 0 && params.stock === 'low') {
    return (
      <EmptyState
        icon={BookOpen}
        title="No low-stock books"
        description="No books are at or below their reorder point right now. Clear the filter to see all books."
        cta={{ label: 'Show all books', href: '/dashboard/books' }}
      />
    );
  }
  if (inventory.total === 0 && params.stock === 'out') {
    return (
      <EmptyState
        icon={BookOpen}
        title="No out-of-stock books"
        description="Nothing is at zero quantity right now. Clear the filter to see all books."
        cta={{ label: 'Show all books', href: '/dashboard/books' }}
      />
    );
  }

  return (
    <BooksInventoryTable
      items={itemsWithImages}
      total={inventory.total}
      valueOnHand={inventory.valueOnHand}
      lookups={lookups}
      canCreate={hasPermission(sessionCtx.role, 'items:create')}
      categories={categories.map((c) => ({
        id: c.id as string,
        name: c.name as string,
      }))}
      locations={locations.map((l) => ({
        id: l.id as string,
        name: l.name as string,
      }))}
      charters={charters.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code ?? null,
      }))}
      suppliers={suppliers.map((s) => ({
        id: s.id as string,
        name: s.name as string,
      }))}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      initialQuery={params.q}
      rowLinkPrefix="/dashboard/books"
      basePath="/dashboard/books"
      showBookFields
      page={page}
      pageSize={PAGE_SIZE}
      trends={trends}
      savedViews={savedViews}
      savedViewScope="books"
      activeWarehouseId={warehouseFilter}
      currentUserId={sessionCtx.userId}
    />
  );
}
