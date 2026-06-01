import { Download } from 'lucide-react';
import Link from 'next/link';

import { DraftPosFromReorderButton } from '@/components/reports/draft-pos-from-reorder-button';
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
import { formatCurrency, formatNumber } from '@/lib/utils';

export default async function ReorderForecastPage() {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.reorderForecast();

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
            <h1 className="text-2xl font-semibold tracking-tight">Reorder forecast</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Items at or below their reorder point. Deficit assumes refilling
              to whichever is greater: reorder qty or reorder point.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DraftPosFromReorderButton itemCount={data.totalItems} />
            <Button asChild variant="outline">
              <a href="/api/reports/reorder-forecast/csv">
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl="/api/reports/reorder-forecast/pdf" />
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Items to reorder" value={formatNumber(data.totalItems)} />
        <Stat label="Total deficit (units)" value={formatNumber(data.totalDeficit)} />
        <Stat label="Estimated cost" value={formatCurrency(data.totalEstimatedCost)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items below par</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reorder at</TableHead>
                <TableHead className="text-right">Reorder qty</TableHead>
                <TableHead className="text-right">Deficit</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground py-8 text-center text-xs">
                    Nothing is below par. Healthy stock levels.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => (
                <TableRow key={r.itemId}>
                  <TableCell className="max-w-[280px] truncate">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{r.sku}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {r.warehouseName ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.quantityOnHand)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatNumber(r.reorderPoint)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatNumber(r.reorderQuantity)}
                  </TableCell>
                  <TableCell className="text-warning text-right font-medium tabular-nums">
                    {formatNumber(r.deficit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(r.estimatedReorderCost)}
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
