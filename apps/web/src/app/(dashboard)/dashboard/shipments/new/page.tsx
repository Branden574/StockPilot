import Link from 'next/link';

import { NewShipmentForm } from '@/components/shipments/new-shipment-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getWarehouseAccess } from '@/lib/auth/warehouse';
import { ChartersService } from '@/server/services/charters';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

export default async function NewShipmentPage() {
  const [whSvc, chSvc, whChSvc, access] = await Promise.all([
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    getWarehouseAccess(),
  ]);
  // Items are no longer pre-fetched at the page level. The form fetches
  // them client-side from /api/inventory/by-warehouse, paginated and
  // scoped to the selected source warehouse — that removes the old
  // org-wide 500-item ceiling and lets us serve thumbnail signed URLs
  // without paying for them on every nav.
  const [allWarehouses, allCharters, pairs] = await Promise.all([
    whSvc.list(),
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
          />
        </CardContent>
      </Card>
    </div>
  );
}
