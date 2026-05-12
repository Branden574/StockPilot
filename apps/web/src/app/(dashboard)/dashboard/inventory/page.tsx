import { Boxes } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
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

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    stock?: string;
    type?: string;
    page?: string;
    sort?: string;
    cat?: string | string[];
    loc?: string | string[];
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

  const sort = parseSort(params.sort);
  const categoryIds = parseIdList(params.cat);
  const locationIds = parseIdList(params.loc);

  const [inventory, categories, locations, suppliers, tags, savedViews] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: lifecycleStatus,
      lowStock: params.stock === 'low',
      outOfStock: params.stock === 'out',
      itemType,
      warehouseId: warehouseFilter,
      categoryIds,
      locationIds,
      sort,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    tagsSvc.list(),
    savedViewsSvc.list('inventory'),
  ]);

  // Per-row 14-day trend series (qty + moves) for the sparkline column.
  // One round trip via stock_movements; flat fallback for items with no
  // movements in the window. See docs/superpowers/specs/2026-05-08-…
  const trends = await getItemTrends(
    inventory.items.map((i) => ({ id: i.id, quantityOnHand: i.quantity_on_hand })),
  );

  // Fetch primary images in batch (1 query + 1 createSignedUrls call,
  // not N round trips). Returns Map<itemId, signedUrl>. Falls back to
  // a custom_fields.thumbnail_url stashed by the bulk-ISBN importer
  // for books that came in before the cover-rehost flow landed.
  const imagesById = await imagesSvc.primaryImagesForItems(
    inventory.items.map((i) => i.id),
  );
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

  // Gate the create / import buttons on `items:create`. Viewers (read-
  // only role) and stock-adjust-only roles should NOT see entry points
  // for new items — the underlying page action also enforces this, but
  // hiding the button is the user-facing fix.
  const canCreate = hasPermission(sessionCtx.role, 'items:create');

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {showingAllTypes
              ? 'Showing every item type — products, books, assets, consumables.'
              : 'Items, SKUs, stock levels — searchable and sortable.'}
          </p>
        </div>
        {canCreate && (
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/inventory/import">Import CSV</Link>
            </Button>
            <Button asChild variant="gradient">
              <Link href="/dashboard/inventory/new">+ New item</Link>
            </Button>
          </div>
        )}
      </div>

      <div className="mt-8">
        {inventory.total === 0 && !params.q && !params.stock ? (
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
        ) : inventory.total === 0 && params.stock === 'low' ? (
          <EmptyState
            icon={Boxes}
            title="No low-stock items"
            description="Nothing is at or below its reorder point right now. Nice."
            cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
          />
        ) : inventory.total === 0 && params.stock === 'out' ? (
          <EmptyState
            icon={Boxes}
            title="Nothing is out of stock"
            description="No active items have a quantity of zero. Clear the filter to see all items."
            cta={{ label: 'Show all items', href: '/dashboard/inventory' }}
          />
        ) : (
          <InventoryTable
            items={itemsWithImages}
            total={inventory.total}
            lookups={lookups}
            canCreate={canCreate}
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
            page={page}
            pageSize={PAGE_SIZE}
            trends={trends}
            savedViews={savedViews}
            savedViewScope="inventory"
            activeWarehouseId={warehouseFilter}
            currentUserId={sessionCtx.userId}
          />
        )}
      </div>
    </div>
  );
}
