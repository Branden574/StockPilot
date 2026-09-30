import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { CustomFieldsService } from '@/server/services/custom-fields';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { TagsService } from '@/server/services/tags';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { can, resolveTerminology, type TrackingMode } from '@stockpilot/core';

export default async function NewRentalItemPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:create')) {
    redirect('/dashboard/rentals/items');
  }

  const supabase = await createClient();

  const [
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    tagsSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    inventorySvc,
    customFieldsSvc,
    forced,
    activeFilter,
    orgRow,
  ] = await Promise.all([
    CategoriesService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    TagsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    CustomFieldsService.forCurrentUser(),
    forcedWarehouseId(),
    getActiveWarehouseFilter(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  const [
    categories,
    locations,
    suppliers,
    tags,
    warehouses,
    charters,
    warehouseCharters,
    recent,
    customFieldDefs,
    sizeScaleValueRows,
    sizeScaleRows,
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ sitesOnly: true }),
    suppliersSvc.listForLookups(),
    tagsSvc.list(),
    warehousesSvc.listNames(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    inventorySvc.getRecentDefaults('product'),
    customFieldsSvc.listDefinitions('item'),
    // The same size-scale reads the inventory New Item page makes. This page
    // renders the same form and creates through the same InventoryService
    // .create(), which enforces a Sports category's required attributes — so
    // the form needs the same facts to show and check them.
    supabase
      .from('size_scale_values')
      .select('size_scale_id, value, is_half')
      .order('size_scale_id', { ascending: true })
      .order('sort_order', { ascending: true }),
    supabase.from('size_scales').select('id, size_system'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
  const { enabled: sportsEnabled } = await checkModuleAccess('sports');

  const sizeScales: Record<string, Array<{ value: string; isHalf: boolean }>> = {};
  for (const row of sizeScaleValueRows.data ?? []) {
    (sizeScales[row.size_scale_id as string] ??= []).push({
      value: row.value as string,
      isHalf: Boolean(row.is_half),
    });
  }
  const sizeScaleSystems: Record<string, string | null> = {};
  for (const row of sizeScaleRows.data ?? []) {
    sizeScaleSystems[row.id as string] = (row.size_system as string | null) ?? null;
  }

  const warehouseIds = new Set(warehouses.map((w) => w.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const defaultWarehouseId =
    forced ??
    (activeFilter && warehouseIds.has(activeFilter) ? activeFilter : null) ??
    (recent?.warehouseId && warehouseIds.has(recent.warehouseId)
      ? recent.warehouseId
      : null);
  const defaultPrimaryLocationId =
    recent?.primaryLocationId &&
    locationIds.has(recent.primaryLocationId) &&
    recent.warehouseId === defaultWarehouseId
      ? recent.primaryLocationId
      : null;

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  return (
    <div className="container mx-auto flex min-h-full max-w-3xl flex-col px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/rentals/items"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to rental items
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New rental item</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Add a canopy, supply, or other circulating asset to the rental catalog.
        </p>
      </div>
      <Card className="flex-1">
        <CardHeader>
          <CardTitle>Item details</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemForm
            defaults={{
              warehouseId: defaultWarehouseId,
              primaryLocationId: defaultPrimaryLocationId,
            }}
            // The sports columns too. Without them this form could not know a
            // category is Jerseys, showed no sports fields, and the server's
            // "Size is required" arrived as a toast with nothing to fill in.
            // With `isRentalFixed` the form shows only the item's own variant
            // fields (size, size system, number...): no product group, no size
            // chips and no mode override, so a rental create stays the single
            // create that carries isRental (see ItemForm's `sportsGrouping`).
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              supports_sizes: Boolean(c.supports_sizes),
              parent_id: (c.parent_id as string | null) ?? null,
              tracking_mode: (c.tracking_mode as TrackingMode | null) ?? null,
              sports_subcategory_key: (c.sports_subcategory_key as string | null) ?? null,
              default_unit_of_measure: (c.default_unit_of_measure as string | null) ?? null,
              size_scale_id: (c.size_scale_id as string | null) ?? null,
              tracking_profile: c.tracking_profile ?? null,
            }))}
            sizeScales={sizeScales}
            sizeScaleSystems={sizeScaleSystems}
            sportsEnabled={sportsEnabled}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
            isRentalFixed={true}
            customFieldDefs={customFieldDefs}
            lotSerialEnabled={lotSerialEnabled}
          />
        </CardContent>
      </Card>
    </div>
  );
}
