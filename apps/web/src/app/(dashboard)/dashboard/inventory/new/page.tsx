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

import { can, resolveTerminology } from '@stockpilot/core';

export default async function NewItemPage() {
  const ctx = await requireOrgContext();
  // Server-side gate: a viewer (or any role without items:create) typing
  // /dashboard/inventory/new directly into the URL bar still bounces to
  // the inventory list. Service-layer `assertPermission` also blocks
  // submit, but redirecting here means they never see the form to
  // begin with.
  if (!can(ctx, 'items:create')) {
    redirect('/dashboard/inventory');
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
  ] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list({ excludeSystem: true }),
    suppliersSvc.list(),
    tagsSvc.list(),
    warehousesSvc.list(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    // Default warehouse + primary location to the user's most-recent
    // item so the form pre-fills the picker for users who always add
    // to the same warehouse. Scoped to product items (the books tab
    // has its own page + scoped lookup).
    inventorySvc.getRecentDefaults('product'),
    customFieldsSvc.listDefinitions('item'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');

  // Resolve effective defaults. Precedence:
  //   1. forcedWarehouseId — warehouse-scoped users are locked here.
  //   2. activeFilter — manager/admin sidebar warehouse dropdown.
  //   3. recent.warehouseId — most-recent product this user created.
  //   4. null — show the placeholder.
  const warehouseIds = new Set(warehouses.map((w) => w.id));
  const locationIds = new Set(locations.map((l) => l.id));
  const defaultWarehouseId =
    forced ??
    (activeFilter && warehouseIds.has(activeFilter) ? activeFilter : null) ??
    (recent?.warehouseId && warehouseIds.has(recent.warehouseId)
      ? recent.warehouseId
      : null);
  // Only carry the recent primary location forward when its parent
  // warehouse matches the chosen default — picking a bin in another
  // warehouse would just confuse the user.
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
            categories={categories.map((c) => ({
              id: c.id as string,
              name: c.name as string,
              supports_sizes: Boolean(c.supports_sizes),
            }))}
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            charters={charters.map((c) => ({ id: c.id, name: c.name }))}
            warehouseCharters={warehouseCharters}
            forcedWarehouseId={forced}
            warehouseLabel={terminology.warehouse_singular}
            charterLabel={terminology.charter_singular}
            customFieldDefs={customFieldDefs}
            lotSerialEnabled={lotSerialEnabled}
          />
        </CardContent>
      </Card>
    </div>
  );
}
