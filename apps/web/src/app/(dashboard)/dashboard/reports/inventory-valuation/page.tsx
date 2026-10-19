import { Suspense } from 'react';
import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { CharterFilterSelect } from '@/components/reports/charter-filter-select';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { ReportBodySkeleton } from '@/components/reports/report-body-skeleton';
import { Button } from '@/components/ui/button';
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
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function InventoryValuationPage({
  searchParams,
}: {
  searchParams: Promise<{ charterId?: string }>;
}) {
  const blocked = await reportPageGate('inventory-valuation');
  if (blocked) return blocked;
  const charterIdPromise = searchParams.then((p) => p.charterId?.trim() || null);

  return <ValuationShell charterIdPromise={charterIdPromise} />;
}

async function ValuationShell({ charterIdPromise }: { charterIdPromise: Promise<string | null> }) {
  const charterId = await charterIdPromise;
  const chartersSvc = await ChartersService.forCurrentUser();
  const charters = await chartersSvc.list();

  const suffix = charterId ? `?charterId=${encodeURIComponent(charterId)}` : '';
  const csvHref = `/api/reports/inventory-valuation/csv${suffix}`;
  const pdfHref = `/api/reports/inventory-valuation/pdf${suffix}`;
  const activeCharter = charterId ? charters.find((c) => c.id === charterId) : undefined;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Inventory valuation"
        subline={
          <>
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
                · Filtered to charter{' '}
                <span className="text-foreground font-medium">{activeCharter.name}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            {charters.length > 0 && <CharterFilterSelect charters={charters} current={charterId} />}
            <Button asChild variant="outline">
              <a href={csvHref}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={pdfHref} />
          </>
        }
      />

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
      <StatStrip>
        <StatStripItem label="Total value" value={formatCurrency(data.totalValue)} />
        <StatStripItem label="Items" value={formatNumber(data.itemCount)} />
        <StatStripItem label="Units on hand" value={formatNumber(data.totalUnits)} />
      </StatStrip>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DetailSection headingId="valuation-by-warehouse-heading" title="By warehouse" flush>
          <Table scrollLabelledBy="valuation-by-warehouse-heading" className="min-w-[360px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byWarehouse.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="text-muted-foreground py-8 text-center text-[13px]"
                  >
                    No items yet.
                  </TableCell>
                </TableRow>
              )}
              {data.byWarehouse.map((w) => (
                <TableRow key={w.warehouseName}>
                  <TableCell>{w.warehouseName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(w.units)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(w.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailSection>

        <DetailSection headingId="valuation-by-category-heading" title="By category" flush>
          <Table scrollLabelledBy="valuation-by-category-heading" className="min-w-[360px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byCategory.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="text-muted-foreground py-8 text-center text-[13px]"
                  >
                    No items yet.
                  </TableCell>
                </TableRow>
              )}
              {data.byCategory.map((c) => (
                <TableRow key={c.categoryName}>
                  <TableCell>{c.categoryName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.units)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(c.value)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailSection>
      </div>

      <DetailSection headingId="valuation-all-items-heading" title="All items" flush>
        <Table scrollLabelledBy="valuation-all-items-heading" className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={7}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No items yet.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell className="max-w-[280px] truncate font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12px]">
                  {r.sku}
                </TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">{r.warehouseName ?? '—'}</TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">{r.categoryName ?? '—'}</TableCell>
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
      </DetailSection>
    </>
  );
}
