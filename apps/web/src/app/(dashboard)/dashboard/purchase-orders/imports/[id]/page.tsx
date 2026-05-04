import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PoImportDetail } from '@/components/po-imports/po-import-detail';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
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

  const [suppliers, warehouses, items] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    (await WarehousesService.forCurrentUser()).list(),
    (await InventoryService.forCurrentUser()).list({ limit: 200 }),
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
        items={items.items.map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
        }))}
      />
    </div>
  );
}
