import { ArrowLeftRight } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MovementsService } from '@/server/services/movements';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { formatNumber, formatRelative } from '@/lib/utils';

const PAGE_SIZE = 50;

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = clampPage(params.page);
  const offset = (page - 1) * PAGE_SIZE;

  const [movementsSvc, warehouseFilter] = await Promise.all([
    MovementsService.forCurrentUser(),
    getActiveWarehouseFilter(),
  ]);
  // Fetch one extra row to detect whether a next page exists without a
  // separate count query (count(*) on stock_movements is slow on big
  // ledgers).
  const movements = await movementsSvc.list({
    limit: PAGE_SIZE + 1,
    offset,
    warehouseId: warehouseFilter ?? undefined,
  });
  const hasNext = movements.length > PAGE_SIZE;
  const visible = hasNext ? movements.slice(0, PAGE_SIZE) : movements;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stock movements</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every quantity change, audited. The ledger is append-only.
          </p>
        </div>
        <p className="text-muted-foreground text-xs tabular-nums">
          Page {page} · {PAGE_SIZE} per page
        </p>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          title={page === 1 ? 'No movements yet' : 'No more movements'}
          description={
            page === 1
              ? 'Movements are recorded automatically when you create items, adjust stock, or receive purchase orders.'
              : 'You have reached the end of the ledger.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Δ</TableHead>
                <TableHead className="text-right">After</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((m) => {
                const itemName = m.item?.name;
                const change = Number(m.quantity_change);
                const actorLabel =
                  m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System');
                return (
                  <TableRow key={m.id as string}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(m.created_at as string)}
                    </TableCell>
                    <TableCell className="font-medium">{itemName ?? '—'}</TableCell>
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
                    <TableCell className="text-xs">
                      <div className="font-medium">{actorLabel}</div>
                      {m.actor?.fullName && m.actor.email && (
                        <div className="text-muted-foreground text-[11px]">
                          {m.actor.email}
                        </div>
                      )}
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

      <div className="mt-4 flex items-center justify-between">
        <Button asChild variant="outline" disabled={page <= 1}>
          <Link
            href={page <= 1 ? '#' : `/dashboard/movements?page=${page - 1}`}
            aria-disabled={page <= 1}
            className={page <= 1 ? 'pointer-events-none opacity-50' : ''}
          >
            ← Newer
          </Link>
        </Button>
        <Button asChild variant="outline" disabled={!hasNext}>
          <Link
            href={hasNext ? `/dashboard/movements?page=${page + 1}` : '#'}
            aria-disabled={!hasNext}
            className={!hasNext ? 'pointer-events-none opacity-50' : ''}
          >
            Older →
          </Link>
        </Button>
      </div>
    </div>
  );
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}
