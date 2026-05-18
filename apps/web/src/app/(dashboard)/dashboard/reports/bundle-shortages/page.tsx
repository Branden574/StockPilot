import { Download } from 'lucide-react';
import Link from 'next/link';

import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
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
import { cn, formatNumber, formatRelative } from '@/lib/utils';

export default async function BundleShortagesPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.bundleShortages(days);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3 sm:gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Bundle shortages</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Items that ran short during a bundle distribution in the last{' '}
              {days} days, grouped by item. The components most worth restocking
              before the next event.
            </p>
          </div>
          <div className="flex gap-2">
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/bundle-shortages/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/bundle-shortages/pdf?days=${days}`} />
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat label="Shortage events" value={formatNumber(data.totalEvents)} />
        <Stat
          label="Total units short"
          value={formatNumber(data.totalUnitsShort)}
          tone="warn"
        />
      </div>

      <div className="bg-card overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Units short</TableHead>
              <TableHead className="text-right">Last short</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                  No shortages logged in the last {days} days. Stock is keeping up.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell>
                  <Link href={`/dashboard/inventory/${r.itemId}`} className="hover:underline">
                    <div className="font-medium">{r.itemName}</div>
                    <div className="text-muted-foreground font-mono text-[11px]">{r.itemSku}</div>
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.events)}</TableCell>
                <TableCell className="text-right tabular-nums font-medium">
                  {formatNumber(r.unitsShort)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs">
                  {r.lastShortAt ? formatRelative(r.lastShortAt) : '—'}
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
      <div className="text-muted-foreground text-xs uppercase tracking-[0.06em]">
        {label}
      </div>
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
          href={`/dashboard/reports/bundle-shortages?days=${d}`}
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
