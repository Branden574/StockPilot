import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { WarehousesService } from '@/server/services/warehouses';
import { formatRelative } from '@/lib/utils';

export default async function CycleCountsPage() {
  const [ccSvc, warehousesSvc] = await Promise.all([
    CycleCountsService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
  ]);
  const [counts, warehouses] = await Promise.all([
    ccSvc.list(),
    warehousesSvc.list(),
  ]);
  const warehouseMap = new Map(warehouses.map((w) => [w.id, w.name]));

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cycle counts</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Recount stock against the system. Approving a count posts adjustments
            for every variance and brings inventory in line with what was counted.
          </p>
        </div>
        <Button asChild variant="gradient">
          <Link href="/dashboard/cycle-counts/new">+ Start a count</Link>
        </Button>
      </div>

      <div className="mt-8">
        {counts.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="No cycle counts yet"
            description="Start a count to snapshot expected quantities, then enter actuals as you walk the warehouse. We post the variance adjustments for you."
            cta={{ label: 'Start your first count', href: '/dashboard/cycle-counts/new' }}
          />
        ) : (
          <div className="bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/dashboard/cycle-counts/${c.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {formatRelative(c.started_at)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {c.warehouse_id
                        ? (warehouseMap.get(c.warehouse_id) ?? '—')
                        : 'All warehouses'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[260px] truncate text-xs">
                      {c.notes ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">
                      {c.completed_at ? formatRelative(c.completed_at) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'in_progress')
    return <Badge variant="warning">In progress</Badge>;
  if (status === 'completed')
    return <Badge variant="success">Completed</Badge>;
  if (status === 'canceled')
    return <Badge variant="destructive">Canceled</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}
