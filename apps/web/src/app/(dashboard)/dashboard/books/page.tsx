import { BookOpen } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Button } from '@/components/ui/button';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;
  const [inventorySvc, categoriesSvc, locationsSvc, warehouseFilter] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);

  const [inventory, categories, locations] = await Promise.all([
    inventorySvc.list({
      q: params.q,
      status: (params.status as 'active' | 'archived' | 'discontinued' | 'all') ?? 'active',
      warehouseId: warehouseFilter,
      itemType: 'book',
    }),
    categoriesSvc.list(),
    locationsSvc.list(),
  ]);

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
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Books are tracked separately here but still count toward total
            inventory value, low stock, and out of stock on the overview.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="gradient">
            <Link href="/dashboard/books/new">+ New book</Link>
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {inventory.total === 0 && !params.q ? (
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
        ) : (
          <InventoryTable
            items={inventory.items}
            total={inventory.total}
            lookups={lookups}
            initialQuery={params.q}
          />
        )}
      </div>
    </div>
  );
}
