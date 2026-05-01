import Link from 'next/link';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CategoriesService } from '@/server/services/categories';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';

export default async function NewItemPage() {
  const [categoriesSvc, locationsSvc, suppliersSvc] = await Promise.all([
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
  ]);
  const [categories, locations, suppliers] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
  ]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/inventory"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to inventory
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New item</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Add a single item. Use CSV import for bulk in Phase 5.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Item details</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemForm
            categories={categories.map((c) => ({ id: c.id as string, name: c.name as string }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
