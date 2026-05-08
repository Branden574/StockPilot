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
import { cn, formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

export default async function BundleActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.bundleActivity(days);

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
            <h1 className="text-2xl font-semibold tracking-tight">Bundle activity</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Distributions over the last {days} days, grouped by bundle. Shows
              how many kits actually moved and at what cost.
            </p>
          </div>
          <div className="flex gap-2">
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/bundle-activity/csv?days=${days}`}>
                <Download className="h-4 w-4" /> Download CSV
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Distribution runs" value={formatNumber(data.totalRuns)} />
        <Stat label="Kits distributed" value={formatNumber(data.totalKits)} />
        <Stat label="Component value out" value={formatCurrency(data.totalValueOut)} />
      </div>

      <div className="bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bundle</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Kits out</TableHead>
              <TableHead className="text-right">Component value</TableHead>
              <TableHead>Top warehouse</TableHead>
              <TableHead className="text-right">Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center text-sm">
                  No distributions in the last {days} days.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.bundleId}>
                <TableCell>
                  <Link
                    href={`/dashboard/bundles/${r.bundleId}`}
                    className="hover:underline"
                  >
                    <div className="font-medium">{r.bundleName}</div>
                    {r.bundleSku && (
                      <div className="text-muted-foreground font-mono text-[11px]">
                        {r.bundleSku}
                      </div>
                    )}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.runs)}
                </TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatNumber(r.kitsOut)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.componentValueOut)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {r.topWarehouseName ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs">
                  {r.lastRunAt ? formatRelative(r.lastRunAt) : '—'}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card rounded-md border px-4 py-3">
      <div className="text-muted-foreground text-xs uppercase tracking-[0.06em]">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</div>
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
          href={`/dashboard/reports/bundle-activity?days=${d}`}
          scroll={false}
          className={cn(
            'rounded-sm px-2 py-1 text-xs',
            d === current ? 'bg-foreground text-background' : 'hover:bg-muted',
          )}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}
