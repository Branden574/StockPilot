import { Download } from 'lucide-react';
import Link from 'next/link';

import { CostTrendIsland } from '@/components/dashboard/charts/cost-trend-island';
import { DetailSection } from '@/components/patterns/detail-section';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { StatePanel } from '@/components/patterns/state-panel';
import { ItemCostHistorySearch } from '@/components/reports/item-cost-history-search';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { formatCurrency, formatNumber } from '@/lib/utils';
import { reportPageGate } from '@/lib/reports/report-page-gate';
import { costHistoryRows } from '@/lib/reports/row-order';
import { ReportsService } from '@/server/services/reports';

export const dynamic = 'force-dynamic';

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

const BACK = <PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>;

export default async function ItemCostHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ itemId?: string; since?: string; until?: string }>;
}) {
  const blocked = await reportPageGate('item-cost-history');
  if (blocked) return blocked;
  const params = await searchParams;
  const { itemId, since, until } = params;

  const orgCtx = await requireOrgContext();
  const supabase = await createClient();

  // ── Item picker: fetch all non-deleted org items ─────────────────────────
  // Org-scoped via RLS + explicit organization_id filter.
  //
  // THE COLUMN IS `deleted_at`, NOT `is_deleted`. This filtered on
  // `.eq('is_deleted', false)` — a column inventory_items has never had (0002
  // defines `deleted_at timestamptz`). PostgREST answers an unknown column
  // with 42703, so `data` was null on EVERY request and `itemRows ?? []`
  // turned that into an empty picker: the report was unreachable for every
  // org since it shipped, and the discarded `error` is why nobody saw a
  // reason. Selecting an item by URL then hit the "not in this org"
  // fail-closed branch below, which made it look like a permission problem.
  const { data: itemRows, error: itemsError } = await supabase
    .from('inventory_items')
    .select('id, sku, name')
    .eq('organization_id', orgCtx.organizationId)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .limit(2000);

  if (itemsError) {
    // Reads fail CLOSED with a visible reason (recurring pattern #1): an empty
    // picker that silently means "the query broke" is exactly how this bug
    // survived. Never throw here — that would take the whole page down.
    console.error('[item-cost-history] item picker query failed:', itemsError);
    // The visible reason the comment above promises. Before, nothing was
    // shown: the picker was simply empty, and an itemId in the URL fell
    // through to "Item not found", which read as a permission problem.
    return (
      <div className={REPORT_PAGE_CLASS}>
        <PageHeader back={BACK} title="Item cost history" />
        <StatePanel
          kind="failed"
          live="assertive"
          title="Couldn't load your items"
          description="Refresh the page to try again."
        />
      </div>
    );
  }

  const items = (itemRows ?? []).map((r) => ({
    id: r.id as string,
    sku: r.sku as string,
    name: r.name as string,
  }));

  // ── No item selected: show the picker ───────────────────────────────────
  if (!itemId) {
    return (
      <div className={REPORT_PAGE_CLASS}>
        <PageHeader
          back={BACK}
          title="Item cost history"
          subline="Select an item to see its unit cost over time, sourced from PO orders and posted receipts."
        />
        <ItemCostHistorySearch items={items} selectedItemId={null} />
      </div>
    );
  }

  // ── Item selected: fail-closed if not in this org ────────────────────────
  const selectedItem = items.find((i) => i.id === itemId) ?? null;

  if (!selectedItem) {
    return (
      <div className={REPORT_PAGE_CLASS}>
        <PageHeader
          back={BACK}
          title="Item cost history"
          subline="Item not found or does not belong to your organisation. Select a different item."
        />
        <ItemCostHistorySearch items={items} selectedItemId={null} />
      </div>
    );
  }

  // ── Fetch cost history ───────────────────────────────────────────────────
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.itemCostHistoryReport(itemId, {
    since: since || undefined,
    until: until || undefined,
  });

  // Build export URLs with all current params.
  const exportParams = new URLSearchParams({ itemId });
  if (since) exportParams.set('since', since);
  if (until) exportParams.set('until', until);
  const exportQs = exportParams.toString();
  const csvUrl = `/api/reports/item-cost-history/csv?${exportQs}`;
  const pdfBaseUrl = `/api/reports/item-cost-history/pdf?${exportQs}`;
  const xlsxUrl = `/api/reports/item-cost-history/xlsx?${exportQs}`;

  // Every supplier's points in one chronological list. The CSV, PDF and
  // XLSX exports read the same helper, so they list the rows in this order.
  const allPoints = costHistoryRows(data.series);

  const supplierCount = data.series.length;

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        back={BACK}
        title="Item cost history"
        subline={
          <>
            <span className="font-mono text-[12px]">{selectedItem.sku}</span>
            <span className="mx-1.5">·</span>
            {selectedItem.name}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href={csvUrl}>
                <Download className="h-4 w-4" /> CSV
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={xlsxUrl}>
                <Download className="h-4 w-4" /> Excel
              </a>
            </Button>
            <PdfDownloadDropdown baseUrl={pdfBaseUrl} />
          </>
        }
      />

      {/* Item switcher and date range: one wrapping filter row. */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="w-full min-w-0 max-w-xl">
          <p className="text-muted-foreground mb-1.5 text-[12.5px]">Switch item</p>
          <ItemCostHistorySearch items={items} selectedItemId={itemId} />
        </div>

        <form
          method="GET"
          action="/dashboard/reports/item-cost-history"
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="itemId" value={itemId} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="since" className="text-muted-foreground text-[12.5px] font-normal">
              From
            </Label>
            <Input
              id="since"
              type="date"
              name="since"
              defaultValue={since ?? ''}
              className="w-[160px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="until" className="text-muted-foreground text-[12.5px] font-normal">
              To
            </Label>
            <Input
              id="until"
              type="date"
              name="until"
              defaultValue={until ?? ''}
              className="w-[160px]"
            />
          </div>
          <Button type="submit" variant="outline" className="max-sm:h-11">
            Apply
          </Button>
          {(since || until) && (
            <Button asChild variant="ghost" className="max-sm:h-11">
              <Link
                href={`/dashboard/reports/item-cost-history?itemId=${encodeURIComponent(itemId)}`}
              >
                Clear
              </Link>
            </Button>
          )}
        </form>
      </div>

      <StatStrip>
        <StatStripItem
          label="Last unit cost"
          value={data.lastUnitCost != null ? formatCurrency(data.lastUnitCost) : '—'}
        />
        <StatStripItem
          label="Average unit cost"
          value={data.avgUnitCost != null ? formatCurrency(data.avgUnitCost) : '—'}
        />
        <StatStripItem
          label="Observations"
          value={`${formatNumber(data.pointCount)} across ${formatNumber(supplierCount)} supplier${supplierCount !== 1 ? 's' : ''}`}
        />
      </StatStrip>

      {/* Cost trend chart — client island (Recharts is client-only). The
          report's only chart, and a real one (no illustrative charts). */}
      {data.series.length > 0 && (
        <DetailSection title="Cost trend">
          <CostTrendIsland series={data.series} />
        </DetailSection>
      )}

      <DetailSection
        headingId="cost-history-observations-heading"
        title={<>All observations ({formatNumber(data.pointCount)})</>}
        flush
      >
        <Table scrollLabelledBy="cost-history-observations-heading" className="min-w-[520px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Supplier</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allPoints.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={4}
                  className="text-muted-foreground py-10 text-center text-[13px]"
                >
                  No cost history found for this item
                  {since || until ? ' in the selected date range' : ''}.
                </TableCell>
              </TableRow>
            )}
            {allPoints.map((p, i) => (
              <TableRow key={i}>
                <TableCell className="max-w-[200px] truncate font-medium">{p.supplier}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {p.date.slice(0, 10)}
                </TableCell>
                <TableCell>
                  <Badge variant={p.source === 'receipt' ? 'success' : 'secondary'}>
                    {p.source === 'receipt' ? 'Receipt' : 'PO'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatCurrency(p.unitCost)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DetailSection>
    </div>
  );
}
