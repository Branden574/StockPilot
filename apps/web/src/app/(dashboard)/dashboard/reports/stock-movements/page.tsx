import { Suspense } from 'react';
import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
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
import { cn, formatNumber } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A strict list: any other `?days=` value reads as the default, 30. */
const RANGE_OPTIONS = [7, 30, 90] as const;

export default async function StockMovementsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('stock-movements');
  if (blocked) return blocked;
  return <StockMovementsShell searchParams={searchParams} />;
}

/**
 * The header with the range and the exports. It waits only for the URL (no
 * data), so it paints at once and the body streams in under it.
 */
async function StockMovementsShell({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 30;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Stock movement summary"
        subline={<>All stock movements over the last {days} days.</>}
        actions={
          <>
            <SegmentedTabs
              size="sm"
              semantics="nav"
              aria-label="Date range"
              activeId={String(days)}
              items={RANGE_OPTIONS.map((d) => ({
                id: String(d),
                label: `${d}d`,
                href: `/dashboard/reports/stock-movements?days=${d}`,
              }))}
            />
            <Button asChild variant="outline">
              <a href={`/api/reports/stock-movements/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/stock-movements/pdf?days=${days}`} />
          </>
        }
      />

      <Suspense fallback={<ReportBodySkeleton />}>
        <StockMovementsBody days={days} />
      </Suspense>
    </div>
  );
}

async function StockMovementsBody({ days }: { days: number }) {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.movementSummary(days);

  return (
    <>
      <StatStrip>
        <StatStripItem label="Total movements" value={formatNumber(data.totalMovements)} />
        <StatStripItem label="Movement types" value={formatNumber(data.byType.length)} />
        <StatStripItem label="Items affected" value={formatNumber(data.topMovers.length)} />
      </StatStrip>

      <DetailSection headingId="movement-summary-by-type-heading" title="By movement type" flush>
        <Table scrollLabelledBy="movement-summary-by-type-heading" className="min-w-[420px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Movements</TableHead>
              <TableHead className="text-right">Total units (gross)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byType.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={3}
                  className="text-muted-foreground py-8 text-center text-[13px]"
                >
                  No movements in this range.
                </TableCell>
              </TableRow>
            )}
            {data.byType.map((t) => (
              <TableRow key={t.movementType}>
                {/* The raw movement_type code, as the CSV and PDF print it
                    (CONFLICTS RP9): no friendly label here. */}
                <TableCell
                  data-movement-type={t.movementType}
                  className="text-ink-2 font-mono text-[12px] uppercase tracking-wider"
                >
                  {t.movementType}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(t.count)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(t.totalQty)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>

      <DetailSection headingId="movement-summary-top-movers-heading" title="Top movers" flush>
        <Table scrollLabelledBy="movement-summary-top-movers-heading" className="min-w-[640px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-8 text-center text-[13px]"
                >
                  No items moved in this range.
                </TableCell>
              </TableRow>
            )}
            {data.topMovers.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell className="max-w-[280px] truncate font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12px]">
                  {r.sku}
                </TableCell>
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
                  className={cn(
                    'text-right font-medium tabular-nums',
                    r.netChange > 0 && 'text-success',
                    r.netChange < 0 && 'text-destructive',
                  )}
                >
                  {r.netChange > 0 ? '+' : ''}
                  {formatNumber(r.netChange)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </>
  );
}
