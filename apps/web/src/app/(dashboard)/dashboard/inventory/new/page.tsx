import Link from 'next/link';

import { ItemForm } from '@/components/inventory/item-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';

import { resolveTerminology } from '@stockpilot/core';

export default async function NewItemPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [
    categoriesSvc,
    locationsSvc,
    suppliersSvc,
    warehousesSvc,
    chartersSvc,
    whChartersSvc,
    forced,
    orgRow,
  ] = await Promise.all([
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
