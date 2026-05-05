import { Boxes } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Button } from '@/components/ui/button';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; stock?: string; type?: string }>;
}) {
  const params = await searchParams;
  const [inventorySvc, categoriesSvc, locationsSvc, imagesSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ItemImagesService.forCurrentUser(),
    getActiveWarehouseFilter(),
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

  const [inventory, categories, locations] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: lifecycleStatus,
      lowStock: params.stock === 'low',
      outOfStock: params.stock === 'out',
      itemType,
      warehouseId: warehouseFilter,
    }),
    categoriesSvc.list(),
    locationsSvc.list(),
  ]);

  // Fetch primary images in batch (1 query + 1 createSignedUrls call,
  // not N round trips). Returns Map<itemId, signedUrl>.
  const imagesById = await imagesSvc.primaryImagesForItems(
    inventory.items.map((i) => i.id),
  );
  const itemsWithImages = inventory.items.map((i) => ({
    ...i,
    image_url: imagesById.get(i.id) ?? null,
  }));

  const lookups = {
    categories: new Map(
      categories.map((c) => [
        c.id as string,
        { name: c.name as string, color: (c.color as string | null) ?? null },
      ]),
    ),
    locations: new Map(locations.map((l) => [l.id as string, { name: l.name as string }])),
  };

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
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/inventory/import">Import CSV</Link>
          </Button>
          <Button asChild variant="gradient">
            <Link href="/dashboard/inventory/new">+ New item</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {inventory.total === 0 && !params.q && !params.stock ? (
          <EmptyState
            icon={Boxes}
            title="No items yet"
            description="Add your first item to start tracking stock, locations, and movements."
            action={
              <Button asChild variant="gradient">
                <Link href="/dashboard/inventory/new">Add your first item</Link>
              </Button>
            }
          />
        ) : inventory.total === 0 && params.stock === 'low' ? (
          <EmptyState
            icon={Boxes}
            title="No low-stock items"
            description="Nothing is at or below its reorder point right now. Nice."
            action={
              <Button asChild variant="outline">
                <Link href="/dashboard/inventory">Show all items</Link>
              </Button>
            }
          />
        ) : inventory.total === 0 && params.stock === 'out' ? (
          <EmptyState
            icon={Boxes}
            title="Nothing is out of stock"
            description="No active items have a quantity of zero."
            action={
              <Button asChild variant="outline">
                <Link href="/dashboard/inventory">Show all items</Link>
              </Button>
            }
          />
        ) : (
          <InventoryTable
            items={itemsWithImages}
            total={inventory.total}
            lookups={lookups}
            initialQuery={params.q}
          />
        )}
      </div>
    </div>
  );
}
