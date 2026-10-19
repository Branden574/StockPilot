import { Download } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
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
import { formatNumber, formatRelative } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The picker's options; the URL itself accepts any whole number of days from 30 to 365. */
const DAY_OPTIONS = [30, 60, 90, 180, 365] as const;

export default async function BundleShortagesPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('bundle-shortages');
  if (blocked) return blocked;
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.bundleShortages(days);

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Bundle shortages"
        subline={
          <>
            Items that ran short during a bundle distribution in the last {days} days, grouped by
            item. The components most worth restocking before the next event.
          </>
        }
        actions={
          <>
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/bundle-shortages/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/bundle-shortages/pdf?days=${days}`} />
          </>
        }
      />

      <StatStrip>
        <StatStripItem label="Shortage events" value={formatNumber(data.totalEvents)} />
        <StatStripItem
          label="Total units short"
          value={formatNumber(data.totalUnitsShort)}
          valueTone="warning"
        />
      </StatStrip>

      <DetailSection flush>
        <Table className="min-w-[520px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="text-right">Units short</TableHead>
              <TableHead className="text-right">Last short</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={4}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No shortages logged in the last {days} days. Stock is keeping up.
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
                      {r.itemName}
                    </div>
                    <div className="text-muted-foreground font-mono text-[11.5px]">{r.itemSku}</div>
                  </IntentLink>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.events)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatNumber(r.unitsShort)}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                  {r.lastShortAt ? formatRelative(r.lastShortAt) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </div>
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
        href: `/dashboard/reports/bundle-shortages?days=${d}`,
        scroll: false,
      }))}
    />
  );
}
