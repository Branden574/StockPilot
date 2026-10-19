import { Suspense } from 'react';
import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { ReportBodySkeleton } from '@/components/reports/report-body-skeleton';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Button } from '@/components/ui/button';
import { IntentLink } from '@/components/ui/intent-link';
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

/** The picker's options; the URL itself accepts any whole number of days from 30 to 365. */
const DAY_OPTIONS = [30, 60, 90, 180, 365] as const;

export default async function DeadStockPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('dead-stock');
  if (blocked) return blocked;
  const daysPromise = searchParams.then((params) => clampDays(params.days));

  return <DaysShell daysPromise={daysPromise} />;
}

async function DaysShell({ daysPromise }: { daysPromise: Promise<number> }) {
  const days = await daysPromise;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Dead stock"
        subline={
          <>
            On-hand items with no out-movement in the last {days} days, ranked by carrying cost. The
            biggest dollar targets to clear, donate, or write down.
          </>
        }
        actions={
          <>
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/dead-stock/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/dead-stock/pdf?days=${days}`} />
          </>
        }
      />

      <Suspense fallback={<ReportBodySkeleton />}>
        <DeadStockBody days={days} />
      </Suspense>
    </div>
  );
}

async function DeadStockBody({ days }: { days: number }) {
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.deadStock(days);

  return (
    <>
      <StatStrip>
        <StatStripItem label="Stagnant items" value={formatNumber(data.itemCount)} />
        <StatStripItem
          label="Carrying value at risk"
          value={formatCurrency(data.totalCarryingValue)}
          valueTone="warning"
        />
      </StatStrip>

      <DetailSection flush>
        <Table className="min-w-[780px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Carrying value</TableHead>
              <TableHead className="text-right">Age (days)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={7}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No dead stock — every item has moved out in the last {days} days. Nice.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell>
                  {/* The one real drill-down: the item's own page. */}
                  <IntentLink
                    href={`/dashboard/inventory/${r.itemId}`}
                    className="group/item block min-w-0"
                  >
                    <div className="text-foreground font-medium group-hover/item:underline">
                      {r.name}
                    </div>
                    <div className="text-muted-foreground font-mono text-[11.5px]">{r.sku}</div>
                  </IntentLink>
                </TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">{r.warehouseName ?? '—'}</TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">
                  {r.categoryName ?? 'Uncategorized'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.quantityOnHand)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.unitCost)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatCurrency(r.carryingValue)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {r.ageDays}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </>
  );
}

function clampDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 90;
  return Math.min(Math.max(Math.floor(n), 30), 365);
}

function DaysPicker({ current }: { current: number }) {
  return (
    <SegmentedTabs
      size="sm"
      semantics="nav"
      aria-label="Date range"
      activeId={String(current)}
      items={DAY_OPTIONS.map((d) => ({
        id: String(d),
        label: `${d}d`,
        href: `/dashboard/reports/dead-stock?days=${d}`,
        scroll: false,
      }))}
    />
  );
}
