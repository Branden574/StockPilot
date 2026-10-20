import { Suspense } from 'react';
import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { ReportBodySkeleton } from '@/components/reports/report-body-skeleton';
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
import { cn, formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A strict list: any other `?days=` value reads as the default, 90. */
const RANGE_OPTIONS = [30, 90, 180, 365] as const;

function pctOrDash(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function daysOrDash(v: number | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}d`;
}

/**
 * A rate's tone: good at or above `good`, caution at or above `fair`, danger
 * below; muted when there is no rate. The percentage is always printed, so
 * the colour is never the only cue.
 */
function rateTone(v: number | null, good: number, fair: number): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= good) return 'text-success';
  if (v >= fair) return 'text-warning';
  return 'text-destructive';
}

export default async function SupplierScorecardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('supplier-scorecard');
  if (blocked) return blocked;
  const paramsPromise = searchParams;

  return <SupplierScorecardShell paramsPromise={paramsPromise} />;
}

async function SupplierScorecardShell({
  paramsPromise,
}: {
  paramsPromise: Promise<{ days?: string }>;
}) {
  const params = await paramsPromise;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 90;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Supplier scorecard"
        subline={
          <>
            Per-supplier on-time rate, lead time, fill rate, and spend over the last {days} days.
            Sorted by spend descending.
          </>
        }
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
                href: `/dashboard/reports/supplier-scorecard?days=${d}`,
              }))}
            />
            <Button asChild variant="outline">
              <a href={`/api/reports/supplier-scorecard/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/supplier-scorecard/pdf?days=${days}`} />
          </>
        }
      />

      <Suspense fallback={<ReportBodySkeleton />}>
        <SupplierScorecardBody days={days} />
      </Suspense>
    </div>
  );
}

async function SupplierScorecardBody({ days }: { days: number }) {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.supplierScorecard(days);

  return (
    <>
      <StatStrip>
        <StatStripItem label="Suppliers" value={formatNumber(data.rows.length)} />
        <StatStripItem label="Total POs" value={formatNumber(data.totalPos)} />
        <StatStripItem label="Total spend" value={formatCurrency(data.totalSpend)} />
      </StatStrip>

      <DetailSection headingId="scorecard-by-supplier-heading" title="By supplier" flush>
        <Table scrollLabelledBy="scorecard-by-supplier-heading" className="min-w-[900px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={9}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
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
                  className={cn('text-right tabular-nums', rateTone(r.onTimeRate, 0.9, 0.7))}
                >
                  {pctOrDash(r.onTimeRate)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {daysOrDash(r.avgLeadDays)}
                </TableCell>
                <TableCell
                  className={cn('text-right tabular-nums', rateTone(r.fillRate, 0.95, 0.8))}
                >
                  {pctOrDash(r.fillRate)}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                  {r.lastReceivedAt ? formatRelative(r.lastReceivedAt) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>

      <p className="text-muted-foreground max-w-3xl text-[12px] leading-[18px]">
        On-time = received on or before the expected date (the day it was received, in your
        organization&apos;s time zone), across POs where both are set. Lead time = average days from
        ordered_at (or created_at if missing) to received_at, only for fully-received POs. Fill rate
        = sum(qty_received) / sum(qty_ordered) across all PO line items in the window.
      </p>
    </>
  );
}
