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

export default async function NewBookPage() {
  const ctx = await requireOrgContext();
  // Same server-side gate as /dashboard/inventory/new. Viewers and
  // any other role without items:create get bounced back to the books
  // list instead of seeing an empty form they can't submit.
  if (!can(ctx, 'items:create')) {
    redirect('/dashboard/books');
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
    locationsSvc.list({ sitesOnly: true }),
    suppliersSvc.list(),
    tagsSvc.list(),
    warehousesSvc.list(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
    // Default warehouse + primary location to the user's most-recent
    // book so the form pre-fills the picker. Scoped to itemType='book'
    // so this doesn't bleed defaults from the products tab.
    inventorySvc.getRecentDefaults('book'),
    customFieldsSvc.listDefinitions('item'),
  ]);

  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');

  // Same defaults resolution as /dashboard/inventory/new — see that
  // file for the precedence rationale.
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
          href="/dashboard/books"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to books
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New book</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Books are tracked alongside regular inventory but live on their own
          tab. Title, ISBN, author, qty.
        </p>
      </div>
      <Card className="flex-1">
        <CardHeader>
          <CardTitle>Book details</CardTitle>
        </CardHeader>
        <CardContent>
          <ItemForm
            itemType="book"
            defaults={{
              warehouseId: defaultWarehouseId,
              primaryLocationId: defaultPrimaryLocationId,
            }}
            categories={categories.map((c) => ({ id: c.id as string, name: c.name as string }))}
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
