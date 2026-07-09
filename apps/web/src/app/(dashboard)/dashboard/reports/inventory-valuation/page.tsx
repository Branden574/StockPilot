import { Suspense } from 'react';
import { Download } from 'lucide-react';
import Link from 'next/link';

import { CharterFilterSelect } from '@/components/reports/charter-filter-select';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { ReportBodySkeleton } from '@/components/reports/report-body-skeleton';
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
import { ChartersService } from '@/server/services/charters';
import { ReportsService } from '@/server/services/reports';
import { formatCurrency, formatNumber } from '@/lib/utils';

export default function InventoryValuationPage({
  searchParams,
}: {
  searchParams: Promise<{ charterId?: string }>;
}) {
  const charterIdPromise = searchParams.then((p) => p.charterId?.trim() || null);

  return <ValuationShell charterIdPromise={charterIdPromise} />;
}

async function ValuationShell({
  charterIdPromise,
}: {
  charterIdPromise: Promise<string | null>;
}) {
  const charterId = await charterIdPromise;
  const chartersSvc = await ChartersService.forCurrentUser();
  const charters = await chartersSvc.list();

  const suffix = charterId ? `?charterId=${encodeURIComponent(charterId)}` : '';
  const csvHref = `/api/reports/inventory-valuation/csv${suffix}`;
  const pdfHref = `/api/reports/inventory-valuation/pdf${suffix}`;
  const activeCharter = charterId ? charters.find((c) => c.id === charterId) : undefined;

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
            <h1 className="text-2xl font-semibold tracking-tight">Inventory valuation</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Cost basis snapshot. Value = qty on hand × unit cost.
              {/* activeCharter only resolves against the ACTIVE-charter list
                  (ChartersService.list() default) — an archived charter's
                  name won't show here even though inventoryValuation() does
                  NOT filter by status, so we only ever ADD a positive note
                  and never claim "not found" (that would be wrong for an
                  archived-but-valid charter). */}
              {activeCharter && (
                <>
                  {' '}
                  · Filtered to charter <span className="font-medium">{activeCharter.name}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {charters.length > 0 && (
              <CharterFilterSelect charters={charters} current={charterId} />
            )}
            <Button asChild variant="outline">
              <a href={csvHref}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={pdfHref} />
          </div>
        </div>
      </div>

      <Suspense fallback={<ReportBodySkeleton />} key={charterId ?? 'all'}>
        <InventoryValuationBody charterId={charterId} />
      </Suspense>
    </div>
  );
}

async function InventoryValuationBody({ charterId }: { charterId: string | null }) {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.inventoryValuation({ charterId });

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total value" value={formatCurrency(data.totalValue)} />
        <Stat label="Items" value={formatNumber(data.itemCount)} />
        <Stat label="Units on hand" value={formatNumber(data.totalUnits)} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By warehouse</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Warehouse</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byWarehouse.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground py-6 text-center text-xs">
                      No items yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.byWarehouse.map((w) => (
                  <TableRow key={w.warehouseName}>
                    <TableCell>{w.warehouseName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(w.units)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(w.value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By category</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byCategory.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground py-6 text-center text-xs">
                      No items yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.byCategory.map((c) => (
                  <TableRow key={c.categoryName}>
                    <TableCell>{c.categoryName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(c.units)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(c.value)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center text-xs">
                    No items yet.
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
                  <TableCell className="text-muted-foreground text-xs">
                    {r.categoryName ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.quantityOnHand)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">
                    {formatCurrency(r.unitCost)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(r.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
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
