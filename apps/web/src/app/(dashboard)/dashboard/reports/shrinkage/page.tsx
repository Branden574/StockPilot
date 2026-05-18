import { Download, FileText } from 'lucide-react';
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
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

const RANGE_OPTIONS = [7, 30, 90] as const;

export default async function ShrinkagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 30;

  const svc = await ReportsService.forCurrentUser();
  const data = await svc.shrinkage(days);

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
              Shrinkage & adjustments
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Negative inventory adjustments over the last {days} days. Cost
              impact uses the item's current unit cost.
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
                  <Link href={`/dashboard/reports/shrinkage?days=${d}`}>
                    {d}d
                  </Link>
                </Button>
              ))}
            </div>
            <Button asChild variant="outline">
              <a href={`/api/reports/shrinkage/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/reports/shrinkage/pdf?days=${days}`}>
                <FileText className="h-4 w-4" /> PDF
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Adjustments" value={formatNumber(data.rows.length)} />
        <Stat label="Units lost" value={formatNumber(data.totalUnits)} />
        <Stat label="Cost impact" value={formatCurrency(data.totalCost)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Negative adjustments</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-xs">
                    No negative adjustments in this range.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => (
                <TableRow key={r.movementId}>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatRelative(r.createdAt)}
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate">{r.itemName}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{r.sku}</TableCell>
                  <TableCell className="text-destructive text-right tabular-nums">
                    {formatNumber(r.quantityChange)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(r.costImpact)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {r.reason ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-[260px] truncate text-xs">
                    {r.notes ?? '—'}
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
