import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CycleCountDetail } from '@/components/cycle-counts/cycle-count-detail';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { WarehousesService } from '@/server/services/warehouses';
import { formatRelative } from '@/lib/utils';

export default async function CycleCountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [ccSvc, warehousesSvc] = await Promise.all([
    CycleCountsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  let header, lines;
  try {
    ({ header, lines } = await ccSvc.get(id));
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const warehouses = await warehousesSvc.list();
  const warehouseName = header.warehouse_id
    ? (warehouses.find((w) => w.id === header.warehouse_id)?.name ?? null)
    : null;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/cycle-counts"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to cycle counts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Cycle count · {formatRelative(header.started_at)}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {warehouseName ?? 'All warehouses'}
          {header.notes ? ` · ${header.notes}` : ''}
        </p>
      </div>

      <CycleCountDetail header={header} lines={lines} />
    </div>
  );
}
