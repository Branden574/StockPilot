import { Download } from 'lucide-react';
import Link from 'next/link';

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
import { formatNumber } from '@/lib/utils';

const RANGE_OPTIONS = [7, 30, 90] as const;

export default async function StockMovementsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 30;

  const svc = await ReportsService.forCurrentUser();
  const data = await svc.movementSummary(days);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Stock movement summary
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              All stock movements over the last {days} days.
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
                  <Link href={`/dashboard/reports/stock-movements?days=${d}`}>
                    {d}d
                  </Link>
                </Button>
              ))}
            </div>
            <Button asChild variant="outline">
              <a href={`/api/reports/stock-movements/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total movements" value={formatNumber(data.totalMovements)} />
        <Stat label="Movement types" value={formatNumber(data.byType.length)} />
        <Stat label="Items affected" value={formatNumber(data.topMovers.length)} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">By movement type</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Movements</TableHead>
                <TableHead className="text-right">Total units (gross)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byType.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground py-6 text-center text-xs">
                    No movements in this range.
                  </TableCell>
                </TableRow>
              )}
              {data.byType.map((t) => (
                <TableRow key={t.movementType}>
                  <TableCell className="text-xs uppercase tracking-wider">
                    {t.movementType}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(t.count)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(t.totalQty)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top movers</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Movements</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topMovers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-6 text-center text-xs">
                    No items moved in this range.
                  </TableCell>
                </TableRow>
              )}
              {data.topMovers.map((r) => (
                <TableRow key={r.itemId}>
                  <TableCell className="max-w-[280px] truncate">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{r.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.movementCount)}
                  </TableCell>
                  <TableCell className="text-success text-right tabular-nums">
                    +{formatNumber(r.totalIn)}
                  </TableCell>
                  <TableCell className="text-destructive text-right tabular-nums">
                    -{formatNumber(r.totalOut)}
                  </TableCell>
                  <TableCell
                    className={
                      'text-right font-medium tabular-nums ' +
                      (r.netChange > 0
                        ? 'text-success'
                        : r.netChange < 0
                          ? 'text-destructive'
                          : '')
                    }
                  >
                    {r.netChange > 0 ? '+' : ''}
                    {formatNumber(r.netChange)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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
