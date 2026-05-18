import { Download } from 'lucide-react';
import Link from 'next/link';

import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const RANGE_OPTIONS = [30, 90, 180, 365] as const;

function pctOrDash(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function daysOrDash(v: number | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}d`;
}

export default async function SupplierScorecardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 90;

  const svc = await ReportsService.forCurrentUser();
  const data = await svc.supplierScorecard(days);

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
            <h1 className="text-2xl font-semibold tracking-tight">Supplier scorecard</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Per-supplier on-time rate, lead time, fill rate, and spend over the last {days} days.
              Sorted by spend descending.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="flex gap-1">
              {RANGE_OPTIONS.map((d) => (
                <Button
                  key={d}
                  asChild
                  variant={d === days ? 'default' : 'outline'}
                  size="sm"
                >
                  <Link href={`/dashboard/reports/supplier-scorecard?days=${d}`}>
                    {d}d
                  </Link>
                </Button>
              ))}
            </div>
            <Button asChild variant="outline">
              <a href={`/api/reports/supplier-scorecard/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/supplier-scorecard/pdf?days=${days}`} />
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Suppliers" value={formatNumber(data.rows.length)} />
        <Stat label="Total POs" value={formatNumber(data.totalPos)} />
        <Stat label="Total spend" value={formatCurrency(data.totalSpend)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By supplier</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">POs</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Open value</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">On-time</TableHead>
                <TableHead className="text-right">Lead time</TableHead>
                <TableHead className="text-right">Fill rate</TableHead>
                <TableHead className="text-right">Last received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground py-8 text-center text-xs">
                    No supplier activity in this range.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => (
                <TableRow key={r.supplierId}>
                  <TableCell className="font-medium">{r.supplierName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.totalPos)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.openPos > 0 ? (
                      <span className="text-warning">{formatNumber(r.openPos)}</span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(r.openValue)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(r.totalSpend)}
                  </TableCell>
                  <TableCell
                    className={
                      'text-right tabular-nums ' +
                      (r.onTimeRate == null
                        ? 'text-muted-foreground'
                        : r.onTimeRate >= 0.9
                          ? 'text-success'
                          : r.onTimeRate >= 0.7
                            ? 'text-warning'
                            : 'text-destructive')
                    }
                  >
                    {pctOrDash(r.onTimeRate)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {daysOrDash(r.avgLeadDays)}
                  </TableCell>
                  <TableCell
                    className={
                      'text-right tabular-nums ' +
                      (r.fillRate == null
                        ? 'text-muted-foreground'
                        : r.fillRate >= 0.95
                          ? 'text-success'
                          : r.fillRate >= 0.8
                            ? 'text-warning'
                            : 'text-destructive')
                    }
                  >
                    {pctOrDash(r.fillRate)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs">
                    {r.lastReceivedAt ? formatRelative(r.lastReceivedAt) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-4 text-[11px]">
        On-time = received_at ≤ expected_at across POs where both are set. Lead time =
        average days from ordered_at (or created_at if missing) to received_at, only
        for fully-received POs. Fill rate = sum(qty_received) / sum(qty_ordered) across
        all PO line items in the window.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border-border rounded-md border px-4 py-3">
      <p className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
