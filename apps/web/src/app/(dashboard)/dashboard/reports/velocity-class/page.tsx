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
import { cn } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

/**
 * The class chips on the theme's tones (they were fixed emerald, sky, amber
 * and zinc): A on the accent wash, B outlined, C on the caution wash, D on the
 * sunk fill. The letter is always printed, so colour is never the only cue.
 */
const CLASS_COLORS: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'border-transparent bg-success-wash text-success',
  B: 'border-line-strong bg-transparent text-foreground',
  C: 'border-transparent bg-warning-wash text-warning',
  D: 'border-line-strong bg-sunk text-ink-2',
};

const CLASS_LABEL: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'A · top 80% of value',
  B: 'B · next 15%',
  C: 'C · bottom 5%',
  D: 'D · dead stock',
};

/** The picker's options; the URL itself accepts any whole number of days from 7 to 365. */
const DAY_OPTIONS = [30, 60, 90, 180, 365] as const;

export default async function VelocityClassPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const blocked = await reportPageGate('velocity-class');
  if (blocked) return blocked;
  const params = await searchParams;
  const days = clampDays(params.days);
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.velocityClass(days);

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title="Velocity classes (ABC)"
        titleId="velocity-class-title"
        subline={
          <>
            Items ranked by dollars-out over the last {days} days. A = your top performers (focus
            stocking effort here), D = items that haven&apos;t moved (consider donating or culling).
          </>
        }
        actions={
          <>
            <DaysPicker current={days} />
            <Button asChild variant="outline">
              <a href={`/api/reports/velocity-class/csv?days=${days}`}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={`/api/reports/velocity-class/pdf?days=${days}`} />
          </>
        }
      />

      <StatStrip>
        <ClassStat label="A items" count={data.summary.A} klass="A" />
        <ClassStat label="B items" count={data.summary.B} klass="B" />
        <ClassStat label="C items" count={data.summary.C} klass="C" />
        <ClassStat label="Dead (D)" count={data.summary.D} klass="D" />
      </StatStrip>

      <div className="border-border bg-card rounded-lg border px-[18px] py-3 text-[13.5px]">
        <span className="text-muted-foreground">Total value moved out · last {days} days:</span>{' '}
        <span className="font-medium tabular-nums">{formatCurrency(data.totalValueOut)}</span>
      </div>

      <DetailSection flush>
        <Table scrollLabelledBy="velocity-class-title" className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Class</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">On hand</TableHead>
              <TableHead className="text-right">Units out</TableHead>
              <TableHead className="text-right">Value out</TableHead>
              <TableHead>Last out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={8}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No items in this org yet.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.itemId}>
                <TableCell>
                  <ClassChip klass={r.velocityClass} />
                </TableCell>
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
                  {formatNumber(r.unitsOut)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(r.valueOut)}
                </TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                  {r.lastOutAt ? formatRelative(r.lastOutAt) : '—'}
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
  return Math.min(Math.max(Math.floor(n), 7), 365);
}

function ClassChip({ klass }: { klass: 'A' | 'B' | 'C' | 'D' }) {
  return (
    <span
      data-velocity-class={klass}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5 text-[11px] font-semibold',
        CLASS_COLORS[klass],
      )}
    >
      {klass}
    </span>
  );
}

function ClassStat({
  label,
  count,
  klass,
}: {
  label: string;
  count: number;
  klass: 'A' | 'B' | 'C' | 'D';
}) {
  return (
    <StatStripItem
      label={
        <span className="flex items-center gap-2">
          <ClassChip klass={klass} />
          {label}
        </span>
      }
      value={formatNumber(count)}
      sub={CLASS_LABEL[klass]}
    />
  );
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
        href: `/dashboard/reports/velocity-class?days=${d}`,
        scroll: false,
      }))}
    />
  );
}
