import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { safeReturnPath } from '@/lib/safe-return-path';
import { createClient } from '@/lib/supabase/server';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';

import { hasPermission, resolveTerminology } from '@stockpilot/core';

export default async function EditItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { id } = await params;
  const { return: returnParam } = await searchParams;
  const ctx = await requireOrgContext();
  // Viewers (or any role without items:update) can't edit existing items.
  // Bounce them back to the detail page instead of letting them see the
  // form. The service layer also throws on submit; this just avoids
  // wasting their time.
  if (!hasPermission(ctx.role, 'items:update')) {
    redirect(`/dashboard/inventory/${id}`);
  }
  const supabase = await createClient();

  const [
    inventorySvc,
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    tagsSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    customFieldsSvc,
    forced,
    orgRow,
  ] = await Promise.all([
    InventoryService.forCurrentUser(),
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    CustomFieldsService.forCurrentUser(),
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

  const [
    categories,
    locations,
    suppliers,
    tags,
    itemTags,
    warehouses,
    charters,
    warehouseCharters,
    customFieldDefs,
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    tagsSvc.list(),
    tagsSvc.listForItem(id),
    warehousesSvc.list(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    customFieldsSvc.listDefinitions('item'),
  ]);

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  // backHref is the target for both the breadcrumb back-link and the
  // post-save navigation in ItemForm. Because we always resolve to a
  // non-empty value (the detail page is the fallback), ItemForm's
  // `router.refresh()` branch is never reached from this page —
  // post-save on the edit page always navigates somewhere, which is
  // the intended UX: the user gets a visible confirmation by landing
  // on the detail page or the list they came from.
  const backHref = safeReturnPath(returnParam) ?? `/dashboard/inventory/${id}`;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={backHref}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
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
              modelNumber: (item.model_number as string | null) ?? '',
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
                ((item.tracking_type as 'none' | 'lot' | 'serial' | null | undefined) ?? 'none') as
                  | 'none'
                  | 'lot'
                  | 'serial',
              status: item.status as 'active' | 'archived' | 'discontinued',
              customFields: (item.custom_fields as Record<string, unknown>) ?? {},
              // Carry the row's actual item_type into the form so a
              // book that lands on the inventory edit URL still shows
              // the book-specific fields (ISBN label, grade, rack,
              // crate, author). Bug fix 2026-05-06.
              itemType:
                ((item.item_type as 'product' | 'book' | 'asset' | 'consumable' | null | undefined) ??
                  'product') as 'product' | 'book' | 'asset' | 'consumable',
            }}
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              supports_sizes: Boolean(c.supports_sizes),
            }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
            initialTagIds={itemTags.map((t) => t.id)}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
            returnHref={backHref}
            customFieldDefs={customFieldDefs}
          />
        </CardContent>
      </Card>
    </div>
  );
}
