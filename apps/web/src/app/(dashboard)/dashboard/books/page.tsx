import { BookOpen } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Button } from '@/components/ui/button';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; stock?: string }>;
}) {
  const params = await searchParams;
  const [inventorySvc, categoriesSvc, locationsSvc, suppliersSvc, imagesSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
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

  const [inventory, categories, locations, suppliers] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: lifecycleStatus,
      lowStock: params.stock === 'low',
      outOfStock: params.stock === 'out',
      warehouseId: warehouseFilter,
      itemType: 'book',
    }),
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
  ]);

  // Batched primary-image fetch (1 select + 1 createSignedUrls) so each
  // book row in the list can show its actual thumbnail.
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
          <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Books are tracked separately here but still count toward total
            inventory value, low stock, and out of stock on the overview.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/books/import">Bulk ISBN import</Link>
          </Button>
          <Button asChild variant="gradient">
            <Link href="/dashboard/books/new">+ New book</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {inventory.total === 0 && !params.q && !params.stock ? (
          <EmptyState
            icon={BookOpen}
            title="No books yet"
            description="Add your first book — title, ISBN, author, quantity. Books roll up into the same dashboard totals as regular items."
            action={
              <Button asChild variant="gradient">
                <Link href="/dashboard/books/new">Add your first book</Link>
              </Button>
            }
          />
        ) : inventory.total === 0 && params.stock === 'low' ? (
          <EmptyState
            icon={BookOpen}
            title="No low-stock books"
            description="No books are at or below their reorder point right now."
            action={
              <Button asChild variant="outline">
                <Link href="/dashboard/books">Show all books</Link>
              </Button>
            }
          />
        ) : inventory.total === 0 && params.stock === 'out' ? (
          <EmptyState
            icon={BookOpen}
            title="No out-of-stock books"
            description="No books are currently at zero quantity."
            action={
              <Button asChild variant="outline">
                <Link href="/dashboard/books">Show all books</Link>
              </Button>
            }
          />
        ) : (
          <InventoryTable
            items={itemsWithImages}
            total={inventory.total}
            lookups={lookups}
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
            }))}
            suppliers={suppliers.map((s) => ({
              id: s.id as string,
              name: s.name as string,
            }))}
            initialQuery={params.q}
            rowLinkPrefix="/dashboard/books"
            basePath="/dashboard/books"
            showBookFields
          />
        )}
      </div>
    </div>
  );
}
