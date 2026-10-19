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
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/** The picker's options; the URL itself accepts any whole number of days from 30 to 365. */
const DAY_OPTIONS = [30, 60, 90, 180, 365] as const;

export default async function BundleActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('bundle-activity');
  if (blocked) return blocked;
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.bundleActivity(days);

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Bundle activity"
        titleId="bundle-activity-title"
        subline={
          <>
            Distributions over the last {days} days, grouped by bundle. Shows how many kits actually
            moved and at what cost.
          </>
        }
        actions={
          <>
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/bundle-activity/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/bundle-activity/pdf?days=${days}`} />
          </>
        }
      />

      <StatStrip>
        <StatStripItem label="Distribution runs" value={formatNumber(data.totalRuns)} />
        <StatStripItem label="Kits distributed" value={formatNumber(data.totalKits)} />
        <StatStripItem label="Component value out" value={formatCurrency(data.totalValueOut)} />
      </StatStrip>

      <DetailSection flush>
        <Table scrollLabelledBy="bundle-activity-title" className="min-w-[720px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Bundle</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Kits out</TableHead>
              <TableHead className="text-right">Component value</TableHead>
              <TableHead>Top warehouse</TableHead>
              <TableHead className="text-right">Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No distributions in the last {days} days.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.bundleId}>
                <TableCell>
                  {/* The one real drill-down: the bundle's own page. */}
                  <IntentLink
                    href={`/dashboard/bundles/${r.bundleId}`}
                    className="group/item block min-w-0"
                  >
                    <div className="text-foreground font-medium group-hover/item:underline">
                      {r.bundleName}
                    </div>
                    {r.bundleSku && (
                      <div className="text-muted-foreground font-mono text-[11.5px]">
                        {r.bundleSku}
                      </div>
                    )}
                  </IntentLink>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.runs)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatNumber(r.kitsOut)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.componentValueOut)}
                </TableCell>
                <TableCell className="text-ink-2 text-[12.5px]">
                  {r.topWarehouseName ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap text-right text-[12.5px]">
                  {r.lastRunAt ? formatRelative(r.lastRunAt) : '—'}
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
        href: `/dashboard/reports/bundle-activity?days=${d}`,
        scroll: false,
      }))}
    />
  );
}
