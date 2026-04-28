import { Boxes } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { InventoryTable } from '@/components/inventory/inventory-table';
import { Button } from '@/components/ui/button';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;

  const [inventory, categories, locations] = await Promise.all([
    (await InventoryService.forCurrentUser()).list({
      q: params.q,
      status: (params.status as 'active' | 'archived' | 'discontinued' | 'all') ?? 'active',
    }),
    (await CategoriesService.forCurrentUser()).list(),
    (await LocationsService.forCurrentUser()).list(),
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
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Items, SKUs, stock levels — searchable and sortable.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/inventory/new">+ New item</Link>
        </Button>
      </div>

      <div className="mt-8">
        {inventory.total === 0 && !params.q ? (
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
