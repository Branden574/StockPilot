import { BookOpen } from 'lucide-react';
import Link from 'next/link';

import { BackfillCoversButton } from '@/components/books/backfill-covers-button';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { BooksInventoryTable } from '@/components/books/books-inventory-table';
import { RackFilterDropdown } from '@/components/inventory/rack-filter-dropdown';
import { Button } from '@/components/ui/button';
import { hasPermission } from '@stockpilot/core';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { getItemTrends } from '@/server/services/movements';
import { SavedViewsService } from '@/server/services/saved-views';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { requireOrgContext } from '@/lib/auth/session';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

const PAGE_SIZE = 50;

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

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    stock?: string;
    page?: string;
    sort?: string;
    cat?: string | string[];
    loc?: string | string[];
    rack?: string;
  }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const [inventorySvc, categoriesSvc, locationsSvc, suppliersSvc, tagsSvc, imagesSvc, savedViewsSvc, warehouseFilter, sessionCtx] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    ItemImagesService.forCurrentUser(),
    SavedViewsService.forCurrentUser(),
    getActiveWarehouseFilter(),
    requireOrgContext(),
  ]);

  const lifecycleStatus =
    params.status === 'archived' ||
    params.status === 'discontinued' ||
    params.status === 'all' ||
    params.status === 'active'
      ? params.status
      : 'active';

  const sort = parseSort(params.sort);
  const categoryIds = parseIdList(params.cat);
  const locationIds = parseIdList(params.loc);
  const rack = typeof params.rack === 'string' ? params.rack : undefined;

  const [inventory, categories, locations, suppliers, tags, savedViews, racks] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: lifecycleStatus,
      lowStock: params.stock === 'low',
      outOfStock: params.stock === 'out',
      warehouseId: warehouseFilter,
      itemType: 'book',
      categoryIds,
      locationIds,
      rack,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    tagsSvc.list(),
    savedViewsSvc.list('books'),
    inventorySvc.listDistinctRacks({ scope: 'books' }),
  ]);

  // Trends + primary images are independent — run in parallel.
  // trends: 14-day sparkline series.
  // imagesById: signed URL from item_images bucket → fallback to
  // custom_fields.thumbnail_url stashed by the bulk-ISBN importer.
  const [trends, imagesById] = await Promise.all([
    getItemTrends(
      inventory.items.map((i) => ({ id: i.id, quantityOnHand: i.quantity_on_hand })),
    ),
    imagesSvc.primaryImagesForItems(inventory.items.map((i) => i.id)),
  ]);
  const itemsWithImages = inventory.items.map((i) => {
    const cf = (i as { custom_fields?: Record<string, unknown> | null })
      .custom_fields;
    const cfThumb =
      cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
        ? (cf.thumbnail_url as string)
        : null;
    return {
      ...i,
      image_url: imagesById.get(i.id) ?? cfThumb ?? null,
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
  };

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
        {inventory.total === 0 && lifecycleStatus === 'archived' && !params.q && !params.stock ? (
          <EmptyState
            icon={BookOpen}
            title="No archived books"
            description="Nothing here yet. Books you archive will show up in this view."
            cta={{ label: 'Back to active books', href: '/dashboard/books' }}
          />
        ) : inventory.total === 0 && !params.q && !params.stock ? (
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
        ) : inventory.total === 0 && params.stock === 'low' ? (
          <EmptyState
            icon={BookOpen}
            title="No low-stock books"
            description="No books are at or below their reorder point right now. Clear the filter to see all books."
            cta={{ label: 'Show all books', href: '/dashboard/books' }}
          />
        ) : inventory.total === 0 && params.stock === 'out' ? (
          <EmptyState
            icon={BookOpen}
            title="No out-of-stock books"
            description="Nothing is at zero quantity right now. Clear the filter to see all books."
            cta={{ label: 'Show all books', href: '/dashboard/books' }}
          />
        ) : (
          <BooksInventoryTable
            items={itemsWithImages}
            total={inventory.total}
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
        )}
      </div>
    </div>
  );
}
