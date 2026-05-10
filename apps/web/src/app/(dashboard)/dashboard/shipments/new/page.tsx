import Link from 'next/link';

import { NewShipmentForm } from '@/components/shipments/new-shipment-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { ChartersService } from '@/server/services/charters';
import { InventoryService } from '@/server/services/inventory';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

export default async function NewShipmentPage() {
  const [whSvc, invSvc, chSvc, whChSvc, access] = await Promise.all([
    WarehousesService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    getWarehouseAccess(),
  ]);
  // We bumped the inventory limit from 200 → 500 so the browseable item
  // picker actually shows the catalog at meaningful sizes. If an org grows
  // past 500 active items, the picker tops out — we'll add cursored
  // pagination in a follow-up; for now this covers ~99% of the data.
  const [allWarehouses, inventory, allCharters, pairs] = await Promise.all([
    whSvc.list(),
    invSvc.list({ limit: 500, status: 'active' }),
    chSvc.list(),
    whChSvc.listPairs(),
  ]);

  // Source list = active warehouses the user can WRITE to. For
  // managers/admins (hasAllAccess) this is every active warehouse;
  // for staff this is their writable assignments.
  const writableSet = new Set(access.writableIds);
  const sourceWarehouses = allWarehouses
    .filter((w) => w.status === 'active')
    .filter((w) => access.hasAllAccess || writableSet.has(w.id))
    .map((w) => ({ id: w.id, name: w.name, code: w.code }));

  // Charters list: every active charter in the org. The form filters
  // client-side via the (warehouse_id, charter_id) pairs once the user
  // picks a source warehouse.
  const charters = allCharters
    .filter((c) => c.status === 'active')
    .map((c) => ({ id: c.id, name: c.name, code: c.code }));

  const items = inventory.items.map((i) => ({
    id: i.id,
    name: i.name,
    sku: i.sku,
    barcode: i.barcode ?? null,
    warehouseId: i.warehouse_id ?? null,
    quantityOnHand: Number(i.quantity_on_hand) || 0,
  }));

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
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
          Build a packing slip from scratch. Pick a source warehouse + receiving
          charter, browse items, then save as a draft.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shipment details</CardTitle>
        </CardHeader>
        <CardContent>
          <NewShipmentForm
            sourceWarehouses={sourceWarehouses}
            charters={charters}
            warehouseCharterPairs={pairs}
            items={items}
          />
        </CardContent>
      </Card>
    </div>
  );
}
