import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
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
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** A strict list: any other `?days=` value reads as the default, 30. */
const RANGE_OPTIONS = [7, 30, 90] as const;

export default async function ShrinkagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('shrinkage');
  if (blocked) return blocked;
  const params = await searchParams;
  const requested = Number(params.days);
  const days = (RANGE_OPTIONS as readonly number[]).includes(requested) ? requested : 30;

  const svc = await ReportsService.forCurrentUser();
  const data = await svc.shrinkage(days);

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Shrinkage & adjustments"
        subline={
          <>
            Negative inventory adjustments over the last {days} days. Cost impact uses the
            item&apos;s current unit cost.
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
                href: `/dashboard/reports/shrinkage?days=${d}`,
              }))}
            />
            <Button asChild variant="outline">
              <a href={`/api/reports/shrinkage/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/shrinkage/pdf?days=${days}`} />
          </>
        }
      />

      <StatStrip>
        <StatStripItem label="Adjustments" value={formatNumber(data.rows.length)} />
        <StatStripItem label="Units lost" value={formatNumber(data.totalUnits)} />
        <StatStripItem label="Cost impact" value={formatCurrency(data.totalCost)} />
      </StatStrip>

      <DetailSection title="Negative adjustments" flush>
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={7}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No negative adjustments in this range.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.movementId}>
                <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                  {formatRelative(r.createdAt)}
                </TableCell>
                <TableCell className="max-w-[240px] truncate font-medium">{r.itemName}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap font-mono text-[12px]">
                  {r.sku}
                </TableCell>
                <TableCell className="text-destructive text-right tabular-nums">
                  {formatNumber(r.quantityChange)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.costImpact)}
                </TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">{r.reason ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground max-w-[260px] truncate text-[12.5px]">
                  {r.notes ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </div>
  );
}
