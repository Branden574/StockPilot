import { Download } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReportsService } from '@/server/services/reports';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

export default async function DeadStockPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.deadStock(days);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dead stock</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              On-hand items with no out-movement in the last {days} days,
              ranked by carrying cost. The biggest dollar targets to clear,
              donate, or write down.
            </p>
          </div>
          <div className="flex gap-2">
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/dead-stock/csv?days=${days}`}>
                <Download className="h-4 w-4" /> Download CSV
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label="Stagnant items" value={formatNumber(data.itemCount)} />
        <Stat
          label="Carrying value at risk"
          value={formatCurrency(data.totalCarryingValue)}
          tone="warn"
        />
      </div>

      <div className="bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Carrying value</TableHead>
              <TableHead className="text-right">Age (days)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-sm">
                  No dead stock — every item has moved out in the last {days} days. Nice.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell>
                  <Link
                    href={`/dashboard/inventory/${r.itemId}`}
                    className="hover:underline"
                  >
                    <div className="font-medium">{r.name}</div>
                    <div className="text-muted-foreground font-mono text-[11px]">{r.sku}</div>
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.warehouseName ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.categoryName ?? 'Uncategorized'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.quantityOnHand)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.unitCost)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatCurrency(r.carryingValue)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.ageDays}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function clampDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.min(Math.max(Math.floor(n), 30), 365);
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div className="border-border bg-card rounded-md border px-4 py-3">
      <div className="text-muted-foreground text-xs uppercase tracking-[0.06em]">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold tabular-nums',
          tone === 'warn' && 'text-warning',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function DaysPicker({ current }: { current: number }) {
  const opts = [30, 60, 90, 180, 365];
  return (
    <div className="border-border bg-background flex items-center gap-1 rounded-md border p-0.5">
      {opts.map((d) => (
        <Link
          key={d}
          href={`/dashboard/reports/dead-stock?days=${d}`}
          scroll={false}
          className={cn(
            'rounded-sm px-2 py-1 text-xs',
            d === current
              ? 'bg-foreground text-background'
              : 'hover:bg-muted',
          )}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}
