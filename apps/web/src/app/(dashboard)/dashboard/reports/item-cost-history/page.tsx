import { Download } from 'lucide-react';
import Link from 'next/link';

import { CostTrendIsland } from '@/components/dashboard/charts/cost-trend-island';
import { ItemCostHistorySearch } from '@/components/reports/item-cost-history-search';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ReportsService } from '@/server/services/reports';

export const dynamic = 'force-dynamic';

export default async function ItemCostHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ itemId?: string; since?: string; until?: string }>;
}) {
  const params = await searchParams;
  const { itemId, since, until } = params;

  const orgCtx = await requireOrgContext();
  const supabase = await createClient();

  // ── Item picker: fetch all non-deleted org items ─────────────────────────
  // Org-scoped via RLS + explicit organization_id filter.
  const { data: itemRows } = await supabase
    .from('inventory_items')
    .select('id, sku, name')
    .eq('organization_id', orgCtx.organizationId)
    .eq('is_deleted', false)
    .order('name', { ascending: true })
    .limit(2000);

  const items = (itemRows ?? []).map((r) => ({
    id: r.id as string,
    sku: r.sku as string,
    name: r.name as string,
  }));

  // ── No item selected: show the picker ───────────────────────────────────
  if (!itemId) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Item cost history</h1>
        <p className="text-muted-foreground mt-1 mb-6 text-sm">
          Select an item to see its unit cost over time, sourced from PO orders and posted receipts.
        </p>
        <ItemCostHistorySearch items={items} selectedItemId={null} />
      </div>
    );
  }

  // ── Item selected: fail-closed if not in this org ────────────────────────
  const selectedItem = items.find((i) => i.id === itemId) ?? null;

  if (!selectedItem) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Item cost history</h1>
        <p className="text-muted-foreground mt-1 mb-4 text-sm">
          Item not found or does not belong to your organisation. Select a different item.
        </p>
        <ItemCostHistorySearch items={items} selectedItemId={null} />
      </div>
    );
  }

  // ── Fetch cost history ───────────────────────────────────────────────────
  const svc = await ReportsService.forCurrentUser();
  const data = await svc.itemCostHistory(itemId, {
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

  // Flatten all series points for the table (chronological across all suppliers).
  const allPoints = data.series
    .flatMap((s) =>
      s.points.map((p) => ({
        supplier: s.supplierName,
        date: p.date,
        source: p.source,
        unitCost: p.unitCost,
      })),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const supplierCount = data.series.length;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/reports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to reports
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Item cost history</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              <span className="font-mono text-xs">{selectedItem.sku}</span>
              <span className="mx-1.5">·</span>
              {selectedItem.name}
            </p>
          </div>
          {/* Export buttons */}
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
      </div>

      {/* Item switcher */}
      <div className="mb-6">
        <p className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wider">
          Switch item
        </p>
        <ItemCostHistorySearch items={items} selectedItemId={itemId} />
      </div>

      {/* Date-range filter */}
      <form
        method="GET"
        action="/dashboard/reports/item-cost-history"
        className="mb-6 flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="itemId" value={itemId} />
        <div className="flex flex-col gap-1">
          <label
            htmlFor="since"
            className="text-muted-foreground text-xs font-medium uppercase tracking-wider"
          >
            From
          </label>
          <input
            id="since"
            type="date"
            name="since"
            defaultValue={since ?? ''}
            className="border-border bg-background h-8 rounded-md border px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="until"
            className="text-muted-foreground text-xs font-medium uppercase tracking-wider"
          >
            To
          </label>
          <input
            id="until"
            type="date"
            name="until"
            defaultValue={until ?? ''}
            className="border-border bg-background h-8 rounded-md border px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" className="self-end">
          Apply
        </Button>
        {(since || until) && (
          <Button asChild variant="ghost" size="sm" className="self-end">
            <Link
              href={`/dashboard/reports/item-cost-history?itemId=${encodeURIComponent(itemId)}`}
            >
              Clear
            </Link>
          </Button>
        )}
      </form>

      {/* Summary stats */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Last unit cost"
          value={data.lastUnitCost != null ? formatCurrency(data.lastUnitCost) : '—'}
        />
        <Stat
          label="Average unit cost"
          value={data.avgUnitCost != null ? formatCurrency(data.avgUnitCost) : '—'}
        />
        <Stat
          label="Observations"
          value={`${formatNumber(data.pointCount)} across ${formatNumber(supplierCount)} supplier${supplierCount !== 1 ? 's' : ''}`}
        />
      </div>

      {/* Cost trend chart — client island (Recharts is client-only) */}
      {data.series.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Cost trend</CardTitle>
          </CardHeader>
          <CardContent>
            <CostTrendIsland series={data.series} />
          </CardContent>
        </Card>
      )}

      {/* Observations table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All observations ({formatNumber(data.pointCount)})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allPoints.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-muted-foreground py-8 text-center text-xs"
                  >
                    No cost history found for this item
                    {since || until ? ' in the selected date range' : ''}.
                  </TableCell>
                </TableRow>
              )}
              {allPoints.map((p, i) => (
                <TableRow key={i}>
                  <TableCell className="max-w-[200px] truncate">{p.supplier}</TableCell>
                  <TableCell className="tabular-nums">{p.date.slice(0, 10)}</TableCell>
                  <TableCell>
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ' +
                        (p.source === 'receipt'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400')
                      }
                    >
                      {p.source === 'receipt' ? 'Receipt' : 'PO'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCurrency(p.unitCost)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border-border rounded-md border px-4 py-3">
      <p className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
