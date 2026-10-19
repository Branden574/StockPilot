import { Suspense } from 'react';
import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { DraftPosFromReorderButton } from '@/components/reports/draft-pos-from-reorder-button';
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
import { ReportsService } from '@/server/services/reports';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function ReorderForecastPage() {
  const blocked = await reportPageGate('reorder-forecast');
  if (blocked) return blocked;
  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Reorder forecast"
        subline={
          <>
            Items at or below their reorder point. Deficit assumes refilling to whichever is
            greater: reorder qty or reorder point.
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href="/api/reports/reorder-forecast/csv">
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl="/api/reports/reorder-forecast/pdf" />
          </>
        }
      />

      <Suspense fallback={<ReportBodySkeleton />}>
        <ReorderForecastBody />
      </Suspense>
    </div>
  );
}

async function ReorderForecastBody() {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.reorderForecast();

  return (
    <>
      {/* Primary action — needs data.totalItems, so it lives in the streamed
          body (it was previously in the header). */}
      <div className="flex justify-end">
        <DraftPosFromReorderButton itemCount={data.totalItems} />
      </div>

      <StatStrip>
        <StatStripItem label="Items to reorder" value={formatNumber(data.totalItems)} />
        <StatStripItem label="Total deficit (units)" value={formatNumber(data.totalDeficit)} />
        <StatStripItem label="Estimated cost" value={formatCurrency(data.totalEstimatedCost)} />
      </StatStrip>

      <DetailSection title="Items below par" flush>
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  Nothing is below par. Healthy stock levels.
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
      </DetailSection>
    </>
  );
}
