import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PoForm } from '@/components/po/po-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';

import { hasPermission } from '@stockpilot/core';

export default async function NewPoPage() {
  // Submit asserts purchase_orders:manage. Without this gate
  // viewers/staff would land on the form, fill it out, and only
  // discover the permission gap when they click Create.
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'purchase_orders:manage')) {
    redirect('/dashboard');
  }
  const [inventorySvc, suppliersSvc, locationsSvc, chartersSvc] = await Promise.all([
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ChartersService.forCurrentUser(),
  ]);
  const [inventory, suppliers, locations, charters] = await Promise.all([
    inventorySvc.list({ limit: 1000 }),
    suppliersSvc.list(),
    locationsSvc.list(),
    chartersSvc.list(),
  ]);

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to purchase orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New purchase order</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>PO details</CardTitle>
        </CardHeader>
        <CardContent>
          <PoForm
            items={inventory.items.map((i) => ({
              id: i.id,
              name: i.name,
              sku: i.sku,
              unit_cost: i.unit_cost,
            }))}
            suppliers={suppliers.map((s) => ({ id: s.id as string, name: s.name as string }))}
            // Only warehouse-backed locations can be receiving destinations — a
            // warehouse-less location makes the PO impossible to receive against.
            locations={locations
              .filter((l) => Boolean((l as { warehouse_id?: string | null }).warehouse_id))
              .map((l) => ({ id: l.id as string, name: l.name as string }))}
            charters={charters.map((c) => ({ id: c.id as string, name: c.name as string }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
