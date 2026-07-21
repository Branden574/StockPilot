import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { RentalActionsPanel } from '@/components/rentals/rental-actions-panel';
import { RentalDetailHeader } from '@/components/rentals/rental-detail-header';
import { requireOrgContext } from '@/lib/auth/session';
import { InventoryService } from '@/server/services/inventory';
import { RentalsService } from '@/server/services/rentals';
import { WarehousesService } from '@/server/services/warehouses';
import { can } from '@stockpilot/core';
import { formatNumber } from '@/lib/utils';

export default async function RentalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  // Same visibility gate as the rentals list page (rentals RLS additionally
  // warehouse-scopes rows; this keeps list/detail consistent for ungranted
  // viewers reaching a rental by direct URL).
  if (!can(ctx, 'rentals:read') && !can(ctx, 'rentals:create') && !can(ctx, 'rentals:manage')) {
    redirect('/dashboard');
  }

  const [rentalsSvc, inventorySvc, warehousesSvc] = await Promise.all([
    RentalsService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);

  const rental = await rentalsSvc.get(id);
  if (!rental) notFound();

  // Resolve item names for each line
  const itemIds = rental.lines.map((l) => l.item_id);
  const [itemRows, warehouses] = await Promise.all([
    itemIds.length > 0 ? inventorySvc.byIds(itemIds) : Promise.resolve([]),
    warehousesSvc.listNames(),
  ]);
  const itemMap = new Map(itemRows.map((i) => [i.id, i]));
  const warehouse = warehouses.find((w) => w.id === rental.warehouse_id);

  const canManage = can(ctx, 'rentals:manage');
  const canCreate = can(ctx, 'rentals:create');

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 sm:px-6">
      {/* Back link */}
      <div className="mb-6">
        <Link href="/dashboard/rentals" className="text-muted-foreground hover:text-foreground text-sm">
          ← Back to rentals
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Rental detail</h1>
      </div>

      <div className="space-y-6">
        {/* Header card */}
        <RentalDetailHeader
          rental={rental}
          warehouseName={warehouse?.name ?? rental.warehouse_id}
        />

        {/* Actions panel — only shown when rental is out and user has permission */}
        {canCreate && (
          <RentalActionsPanel
            rentalId={rental.id}
            status={rental.status}
            canManage={canManage}
          />
        )}

        {/* Lines table */}
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="text-sm font-semibold">Items ({rental.lines.length})</h2>
          </div>
          {rental.lines.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No items on this rental.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Item</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">SKU</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Qty</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground hidden sm:table-cell">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rental.lines.map((line) => {
                  const item = itemMap.get(line.item_id);
                  return (
                    <tr key={line.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        {item ? (
                          <Link
                            href={`/dashboard/rentals/items/${line.item_id}`}
                            className="font-medium hover:underline"
                          >
                            {item.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{line.item_id}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {item?.sku ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatNumber(line.quantity)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                        {line.notes ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
