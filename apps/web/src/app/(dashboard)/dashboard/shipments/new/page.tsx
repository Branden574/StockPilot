import Link from 'next/link';

import { NewShipmentForm } from '@/components/shipments/new-shipment-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { InventoryService } from '@/server/services/inventory';
import { WarehousesService } from '@/server/services/warehouses';

export default async function NewShipmentPage() {
  const [whSvc, invSvc, access] = await Promise.all([
    WarehousesService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    getWarehouseAccess(),
  ]);
  const [allWarehouses, inventory] = await Promise.all([
    whSvc.list(),
    invSvc.list({ limit: 200, status: 'active' }),
  ]);

  // Source list = active warehouses the user can WRITE to. For
  // managers/admins (hasAllAccess) this is every active warehouse;
  // for staff this is their writable assignments.
  const writableSet = new Set(access.writableIds);
  const sourceWarehouses = allWarehouses
    .filter((w) => w.status === 'active')
    .filter((w) => access.hasAllAccess || writableSet.has(w.id))
    .map((w) => ({ id: w.id, name: w.name, code: w.code }));

  // Destination = ANY active warehouse. The form filters out the
  // currently-selected source on the client side.
  const destinationWarehouses = allWarehouses
    .filter((w) => w.status === 'active')
    .map((w) => ({ id: w.id, name: w.name, code: w.code }));

  const items = inventory.items.map((i) => ({
    id: i.id,
    name: i.name,
    sku: i.sku,
    barcode: i.barcode ?? null,
    quantityOnHand: Number(i.quantity_on_hand) || 0,
  }));

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/shipments"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to shipments
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          New shipment
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Build a packing slip from scratch. Pick a source + destination
          warehouse, add line items, then save as a draft.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shipment details</CardTitle>
        </CardHeader>
        <CardContent>
          <NewShipmentForm
            sourceWarehouses={sourceWarehouses}
            destinationWarehouses={destinationWarehouses}
            items={items}
          />
        </CardContent>
      </Card>
    </div>
  );
}
