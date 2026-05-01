import Link from 'next/link';

import { PoForm } from '@/components/po/po-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';

export default async function NewPoPage() {
  const [inventorySvc, suppliersSvc, locationsSvc] = await Promise.all([
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
  ]);
  const [inventory, suppliers, locations] = await Promise.all([
    inventorySvc.list({ limit: 1000 }),
    suppliersSvc.list(),
    locationsSvc.list(),
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
            locations={locations.map((l) => ({ id: l.id as string, name: l.name as string }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
