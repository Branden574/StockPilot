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
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

const CLASS_COLORS: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  B: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  C: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  D: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300',
};

const CLASS_LABEL: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'A · top 80% of value',
  B: 'B · next 15%',
  C: 'C · bottom 5%',
  D: 'D · dead stock',
};

export default async function VelocityClassPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.velocityClass(days);

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
            <h1 className="text-2xl font-semibold tracking-tight">Velocity classes (ABC)</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Items ranked by dollars-out over the last {days} days. A = your
              top performers (focus stocking effort here), D = items that
              haven't moved (consider donating or culling).
            </p>
          </div>
          <div className="flex gap-2">
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/velocity-class/csv?days=${days}`}>
                <Download className="h-4 w-4" /> Download CSV
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ClassStat label="A items" count={data.summary.A} klass="A" />
        <ClassStat label="B items" count={data.summary.B} klass="B" />
        <ClassStat label="C items" count={data.summary.C} klass="C" />
        <ClassStat label="Dead (D)" count={data.summary.D} klass="D" />
      </div>

      <div className="mb-6 rounded-md border border-border bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">Total value moved out · last {days} days:</span>{' '}
        <span className="font-medium tabular-nums">{formatCurrency(data.totalValueOut)}</span>
      </div>

      <div className="bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Class</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Units out</TableHead>
              <TableHead className="text-right">Value out</TableHead>
              <TableHead>Last out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground py-8 text-center text-sm">
                  No items in this org yet.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-[11px] font-semibold',
                      CLASS_COLORS[r.velocityClass],
                    )}
                  >
                    {r.velocityClass}
                  </span>
                </TableCell>
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
                  {formatNumber(r.unitsOut)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.valueOut)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.lastOutAt ? formatRelative(r.lastOutAt) : '—'}
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
  return Math.min(Math.max(Math.floor(n), 7), 365);
}

function ClassStat({
  label,
  count,
  klass,
}: {
  label: string;
  count: number;
  klass: 'A' | 'B' | 'C' | 'D';
}) {
  return (
    <div className="border-border bg-card rounded-md border px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-[11px] font-semibold',
            CLASS_COLORS[klass],
          )}
        >
          {klass}
        </span>
        <span className="text-muted-foreground text-xs uppercase tracking-[0.06em]">
          {label}
        </span>
      </div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
        {formatNumber(count)}
      </div>
      <div className="text-muted-foreground mt-0.5 text-[11px]">
        {CLASS_LABEL[klass]}
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
          href={`/dashboard/reports/velocity-class?days=${d}`}
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
