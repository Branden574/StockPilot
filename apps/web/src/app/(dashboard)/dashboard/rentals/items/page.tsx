import { Boxes } from 'lucide-react';
import Link from 'next/link';

import { RentalsTabs } from '@/components/rentals/rentals-tabs';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';
import { EmptyState } from '@/components/ui/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Button } from '@/components/ui/button';
import { can } from '@stockpilot/core';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { getItemTrends } from '@/server/services/movements';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { requireOrgContext } from '@/lib/auth/session';

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

export default async function RentalItemsPage({
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
  }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const [inventorySvc, categoriesSvc, locationsSvc, suppliersSvc, tagsSvc, imagesSvc, sessionCtx] =
    await Promise.all([
      InventoryService.forCurrentUser(),
      CategoriesService.forCurrentUser(),
      LocationsService.forCurrentUser(),
      SuppliersService.forCurrentUser(),
      TagsService.forCurrentUser(),
      ItemImagesService.forCurrentUser(),
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

  // Defense-in-depth: load with includeRentals=true (to bypass the default
  // is_rental=false filter) then additionally filter client-side to is_rental=true.
  // The InventoryService list() method with includeRentals=true returns ALL items
  // (both regular and rental). We then filter to only rental items here.
  // This double-filter ensures rental items are shown even if the
  // includeRentals flag is removed from the service for any reason.
  const inventory = await inventorySvc.list({
    q: params.q,
    status: lifecycleStatus,
    lowStock: params.stock === 'low',
    outOfStock: params.stock === 'out',
    itemType: 'all',
    categoryIds,
    locationIds,
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    includeRentals: true,
  });

  // Defense-in-depth filter: only show is_rental=true items
  const rentalItems = inventory.items.filter(
    (i) => (i as { is_rental?: boolean }).is_rental === true,
  );
  const rentalTotal = rentalItems.length; // approximate; pagination is over all items

  const [categories, locations, suppliers, tags] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ excludeSystem: true }),
    suppliersSvc.list(),
    tagsSvc.list(),
  ]);

  const itemIdList = rentalItems.map((i) => i.id);
  const [trends, imagesById, reservedByItem] = await Promise.all([
    getItemTrends(
      rentalItems.map((i) => ({ id: i.id, quantityOnHand: i.quantity_on_hand })),
    ),
    imagesSvc.primaryImagesWithThumbsForItems(itemIdList),
    // Rentals reserve stock instead of decrementing on-hand — surface
    // available + out-on-rental per row. Same active-reservation sum the
    // /rentals/new catalog uses.
    inventorySvc.reservedQuantityByItemIds(itemIdList),
  ]);

  const itemsWithImages = rentalItems.map((i) => {
    const cf = (i as { custom_fields?: Record<string, unknown> | null }).custom_fields;
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
  };

  const canCreate = can(sessionCtx, 'items:create');

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rentals</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {lifecycleStatus === 'archived'
              ? 'Archived rental items.'
              : 'Items available for rental — canopies, supplies, equipment.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ArchiveViewToggle
            paramName="status"
            view={lifecycleStatus === 'archived' ? 'archived' : 'active'}
          />
          {canCreate && lifecycleStatus !== 'archived' && (
            <Button asChild variant="gradient">
              <Link href="/dashboard/rentals/items/new">+ New item</Link>
            </Button>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="mt-6">
        <RentalsTabs activeTab="items" />
      </div>

      <div className="mt-8">
        {rentalTotal === 0 && lifecycleStatus === 'archived' && !params.q && !params.stock ? (
          <EmptyState
            icon={Boxes}
            title="No archived rental items"
            description="Nothing here yet."
            cta={{ label: 'Back to active rental items', href: '/dashboard/rentals/items' }}
          />
        ) : rentalTotal === 0 && !params.q && !params.stock ? (
          <EmptyState
            icon={Boxes}
            title="No rental items yet"
            description={
              canCreate
                ? 'Add canopies, supplies, and other circulating assets that staff can check out.'
                : 'No rental items have been added yet.'
            }
            cta={
              canCreate
                ? { label: 'Add your first rental item', href: '/dashboard/rentals/items/new' }
                : undefined
            }
          />
        ) : rentalTotal === 0 && params.q ? (
          <EmptyState
            icon={Boxes}
            title="No rental items match your search"
            description={`Nothing matched "${params.q.slice(0, 40)}". Try a different name or SKU.`}
            cta={{ label: 'Clear search', href: '/dashboard/rentals/items' }}
          />
        ) : (
          <InventoryTable
            items={itemsWithImages}
            total={rentalTotal}
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
            rowLinkPrefix="/dashboard/rentals/items"
            basePath="/dashboard/rentals/items"
            activeWarehouseId={null}
            currentUserId={sessionCtx.userId}
            reservedByItem={reservedByItem}
          />
        )}
      </div>
    </div>
  );
}
