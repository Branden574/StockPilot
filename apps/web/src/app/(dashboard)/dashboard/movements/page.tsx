import { ArrowLeftRight } from 'lucide-react';

import { EmptyState } from '@/components/dashboard/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InventoryService } from '@/server/services/inventory';
import { MovementsService } from '@/server/services/movements';
import { formatNumber, formatRelative } from '@/lib/utils';

export default async function MovementsPage() {
  const movementsSvc = await MovementsService.forCurrentUser();
  const inventorySvc = await InventoryService.forCurrentUser();

  const [movements, inventory] = await Promise.all([
    movementsSvc.list({ limit: 200 }),
    inventorySvc.list({ limit: 1000, status: 'all' }),
  ]);

  const itemsById = new Map(inventory.items.map((i) => [i.id, i]));

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Stock movements</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every quantity change, audited. The ledger is append-only.
        </p>
      </div>

      {movements.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title="No movements yet"
          description="Movements are recorded automatically when you create items, adjust stock, or receive purchase orders."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((m) => {
                const item = itemsById.get(m.item_id as string);
                const change = Number(m.quantity_change);
                return (
                  <TableRow key={m.id as string}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(m.created_at as string)}
                    </TableCell>
                    <TableCell className="font-medium">{item?.name ?? '—'}</TableCell>
                    <TableCell className="text-xs uppercase tracking-wider text-muted-foreground">
                      {m.movement_type as string}
                    </TableCell>
                    <TableCell
                      className={
                        'text-right font-mono tabular-nums ' +
                        (change > 0 ? 'text-success' : change < 0 ? 'text-destructive' : '')
                      }
                    >
                      {change > 0 ? '+' : ''}
                      {formatNumber(change)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(Number(m.new_quantity))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {(m.reason as string | null) ?? (m.notes as string | null) ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
