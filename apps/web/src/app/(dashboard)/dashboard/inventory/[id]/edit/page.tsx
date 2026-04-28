import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CategoriesService } from '@/server/services/categories';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';

export default async function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inventorySvc = await InventoryService.forCurrentUser();

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, locations, suppliers] = await Promise.all([
    (await CategoriesService.forCurrentUser()).list(),
    (await LocationsService.forCurrentUser()).list(),
    (await SuppliersService.forCurrentUser()).list(),
  ]);

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link href={`/dashboard/inventory/${id}`} className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to item
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit item</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{item.name as string}</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemForm
            defaults={{
              id,
              name: item.name as string,
              sku: item.sku as string,
              barcode: (item.barcode as string | null) ?? '',
              description: (item.description as string | null) ?? '',
              categoryId: (item.category_id as string | null) ?? null,
              supplierId: (item.supplier_id as string | null) ?? null,
              primaryLocationId: (item.primary_location_id as string | null) ?? null,
              unitCost: item.unit_cost as number,
              retailPrice: item.retail_price as number,
              quantityOnHand: item.quantity_on_hand as number,
              reorderPoint: item.reorder_point as number,
              reorderQuantity: item.reorder_quantity as number,
              unitOfMeasure: item.unit_of_measure as string,
              binLocation: (item.bin_location as string | null) ?? '',
              status: item.status as 'active' | 'archived' | 'discontinued',
              customFields: (item.custom_fields as Record<string, unknown>) ?? {},
            }}
            categories={categories.map((c) => ({ id: c.id as string, name: c.name as string }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
