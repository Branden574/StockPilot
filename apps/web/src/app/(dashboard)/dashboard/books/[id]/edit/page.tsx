import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';

import { resolveTerminology } from '@stockpilot/core';

/**
 * Book edit form. Mirrors /dashboard/inventory/[id]/edit but tells
 * ItemForm to render in book mode — the form then shows the
 * book-specific fields (ISBN-as-barcode label, grade, rack number,
 * rack row, crate color, crate number, author) instead of the
 * generic product field set.
 *
 * Books are stored in the same `inventory_items` table as products,
 * just with `item_type='book'`. The InventoryService lookup is
 * identical between the two tabs — only the form variant differs.
 */
export default async function EditBookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [
    inventorySvc,
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    forced,
    orgRow,
  ] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    forcedWarehouseId(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, locations, suppliers, warehouses, charters, warehouseCharters] =
    await Promise.all([
      categoriesSvc.list(),
      locationsSvc.list(),
      suppliersSvc.list(),
      warehousesSvc.list(),
      chartersSvc.list(),
      whChartersSvc.listPairs(),
    ]);

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/books/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to book
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit book</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{item.name as string}</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemForm
            // itemType=book at the top level guarantees the form
            // renders in book mode even if defaults.itemType is
            // somehow stale or missing — belt-and-suspenders.
            itemType="book"
            defaults={{
              id,
              name: item.name as string,
              sku: item.sku as string,
              barcode: (item.barcode as string | null) ?? '',
              description: (item.description as string | null) ?? '',
              categoryId: (item.category_id as string | null) ?? null,
              supplierId: (item.supplier_id as string | null) ?? null,
              primaryLocationId: (item.primary_location_id as string | null) ?? null,
              warehouseId: (item.warehouse_id as string | null) ?? null,
              charterId: (item.charter_id as string | null) ?? null,
              unitCost: item.unit_cost as number,
              retailPrice: item.retail_price as number,
              quantityOnHand: item.quantity_on_hand as number,
              reorderPoint: item.reorder_point as number,
              reorderQuantity: item.reorder_quantity as number,
              unitOfMeasure: item.unit_of_measure as string,
              binLocation: (item.bin_location as string | null) ?? '',
              trackingType:
                ((item.tracking_type as 'none' | 'lot' | 'serial' | null | undefined) ??
                  'none') as 'none' | 'lot' | 'serial',
              status: item.status as 'active' | 'archived' | 'discontinued',
              customFields: (item.custom_fields as Record<string, unknown>) ?? {},
              itemType: 'book',
            }}
            categories={categories.map((c) => ({ id: c.id as string, name: c.name as string }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
          />
        </CardContent>
      </Card>
    </div>
  );
}
