import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PoImportDetail } from '@/components/po-imports/po-import-detail';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PoImportsService } from '@/server/services/po-imports';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

export default async function PoImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await PoImportsService.forCurrentUser();

  let header, lines;
  try {
    ({ header, lines } = await svc.get(id));
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [suppliers, warehouses, items, charters, locations] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    (await WarehousesService.forCurrentUser()).list(),
    (await InventoryService.forCurrentUser()).list({ limit: 500, itemType: 'all' }),
    (await ChartersService.forCurrentUser()).list(),
    (await LocationsService.forCurrentUser()).list(),
  ]);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders/imports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to imports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {header.file_name}
        </h1>
      </div>
      <PoImportDetail
        header={header}
        lines={lines}
        suppliers={suppliers.map((s) => ({
          id: s.id as string,
          name: s.name as string,
        }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        charters={charters.map((c) => ({ id: c.id, name: c.name }))}
        locations={(locations as Array<{ id: string; name: string; warehouse_id: string | null }>)
          .filter((l) => l.warehouse_id)
          .map((l) => ({ id: l.id, name: l.name, warehouseId: l.warehouse_id as string }))}
        items={items.items.map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
          quantityOnHand: Number(i.quantity_on_hand) || 0,
        }))}
      />
    </div>
  );
}
