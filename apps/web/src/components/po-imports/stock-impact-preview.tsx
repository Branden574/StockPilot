'use client';

import { AlertTriangle, ArrowRight, CheckCircle2, MinusCircle, Package } from 'lucide-react';
import * as React from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCurrency, formatNumber } from '@/lib/utils';

import type { PoImportLineRow } from '@/server/services/po-imports';

export interface PreviewItem {
  id: string;
  sku: string;
  name: string;
  quantityOnHand: number;
}

export interface PreviewLineOverride {
  itemId?: string | null;
  skip?: boolean;
}

interface StockImpactPreviewProps {
  lines: PoImportLineRow[];
  overrides: Record<string, PreviewLineOverride>;
  items: PreviewItem[];
  /**
   * Model B: multiple `items` rows can share one SKU (one row per
   * charter/rack "placement" — see lib/inventory/group-by-sku.ts). Sum of
   * quantityOnHand over EVERY row sharing a SKU, keyed by sku — computed by
   * the page from the SAME full items list it already loads (no extra DB
   * query). Optional: omitting it just falls back to the matched
   * placement's own qty (single-placement SKUs render identically either
   * way).
   */
  skuTotalBySku?: Map<string, number>;
}

export interface PreviewSummary {
  mappedCount: number;
  unmappedCount: number;
  skippedCount: number;
  nonInventoryCount: number;
  totalUnits: number;
  totalCost: number;
}

interface PreviewRow {
  lineId: string;
  lineNumber: number;
  description: string;
  qty: number;
  cost: number;
  itemId: string | null;
  itemSku: string | null;
  itemName: string | null;
  currentQty: number | null;
  projectedQty: number | null;
  /**
   * SKU aggregate (Model B): the sku's on-hand total summed across EVERY
   * placement sharing it, before/after this preview's deltas. Null when
   * there's no known target SKU yet (skipped / non-inventory / a
   * not-yet-linked create-new line with no accepted suggestion) — mirrors
   * currentQty/projectedQty's null-ness for those statuses.
   */
  skuTotalCurrentQty: number | null;
  skuTotalProjectedQty: number | null;
  status: 'mapped' | 'unmapped' | 'skipped' | 'non-inventory';
}

export function buildPreview(
  lines: PoImportLineRow[],
  overrides: Record<string, PreviewLineOverride>,
  items: PreviewItem[],
  skuTotalBySku: Map<string, number> = new Map(),
): { rows: PreviewRow[]; summary: PreviewSummary } {
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const aggregateDelta = new Map<string, number>(); // itemId → cumulative qty delta
  const skuAggregateDelta = new Map<string, number>(); // sku → cumulative qty delta across ALL its placements

  // First pass: compute per-line status + qty delta, accumulate per-item delta
  // so a line that adds 10 to item X stacks correctly on the projected qty
  // when a second line also adds 5 to item X.
  const interim = lines.map<PreviewRow>((l) => {
    const o = overrides[l.id] ?? {};
    const effectiveItemId = o.itemId !== undefined ? o.itemId : l.item_id;
    const qty = Number(l.qty_ordered_original ?? 0) || 0;
    const cost = Number(l.line_total ?? 0) || 0;
    const description = l.description ?? '(no description)';
    if (o.skip === true) {
      return {
        lineId: l.id,
        lineNumber: l.line_number,
        description,
        qty,
        cost,
        itemId: null,
        itemSku: null,
        itemName: null,
        currentQty: null,
        projectedQty: null,
        skuTotalCurrentQty: null,
        skuTotalProjectedQty: null,
        status: 'skipped',
      };
    }
    if (l.line_type !== 'inventory') {
      return {
        lineId: l.id,
        lineNumber: l.line_number,
        description,
        qty,
        cost,
        itemId: null,
        itemSku: null,
        itemName: null,
        currentQty: null,
        projectedQty: null,
        skuTotalCurrentQty: null,
        skuTotalProjectedQty: null,
        status: 'non-inventory',
      };
    }
    if (!effectiveItemId) {
      // Matching is ADVISORY only (Tasks 2/3): a line can carry a
      // suggested_item_id (barcode/ISBN/vendor-mapping hit) while still
      // being unresolved — the default is CREATE-NEW until a human
      // explicitly accepts the suggestion (which sets item_id/override and
      // takes the 'mapped' branch above instead). So this projection must
      // NEVER look up the suggested item's real stock (e.g. "500 → 510") —
      // it projects against a brand-new instance starting at 0, same as any
      // other not-yet-created item.
      const willCreateNew = Boolean(l.suggested_item_id);
      // The SKU total mirrors currentQty/projectedQty here for the same
      // reason: there is no `sku` field on a PO import line, only an
      // advisory suggested_item_id, and an unaccepted suggestion must NEVER
      // borrow the suggested item's real numbers (including its SKU's real
      // total). A brand-new item's SKU has no other placements yet, so 0 is
      // the only number this projection can honestly show.
      return {
        lineId: l.id,
        lineNumber: l.line_number,
        description,
        qty,
        cost,
        itemId: null,
        itemSku: null,
        itemName: null,
        currentQty: willCreateNew ? 0 : null,
        projectedQty: willCreateNew ? qty : null,
        skuTotalCurrentQty: willCreateNew ? 0 : null,
        skuTotalProjectedQty: willCreateNew ? qty : null,
        status: 'unmapped',
      };
    }
    const item = itemsById.get(effectiveItemId);
    aggregateDelta.set(effectiveItemId, (aggregateDelta.get(effectiveItemId) ?? 0) + qty);
    const itemSku = item?.sku ?? null;
    if (itemSku) {
      skuAggregateDelta.set(itemSku, (skuAggregateDelta.get(itemSku) ?? 0) + qty);
    }
    return {
      lineId: l.id,
      lineNumber: l.line_number,
      description,
      qty,
      cost,
      itemId: effectiveItemId,
      itemSku,
      itemName: item?.name ?? null,
      currentQty: item?.quantityOnHand ?? 0,
      projectedQty: null, // filled in second pass
      skuTotalCurrentQty: null, // filled in second pass
      skuTotalProjectedQty: null, // filled in second pass
      status: 'mapped',
    };
  });

  // Second pass: for mapped rows, projectedQty = currentQty + total delta on
  // that item (so two lines hitting the same SKU show the same projection).
  // skuTotalCurrentQty/skuTotalProjectedQty are the Model B aggregate: the
  // SKU's full on-hand total (summed across every placement sharing it, per
  // skuTotalBySku from the page) plus every line's delta against ANY
  // placement of that SKU (skuAggregateDelta) — so two lines landing on two
  // different placements of the same SKU both report the same combined
  // total, distinct from their own placement's individual math above.
  const rows = interim.map((r) => {
    if (r.status !== 'mapped' || !r.itemId) return r;
    const totalDelta = aggregateDelta.get(r.itemId) ?? 0;
    const projectedQty = (r.currentQty ?? 0) + totalDelta;
    const skuBaseline = r.itemSku
      ? (skuTotalBySku.get(r.itemSku) ?? (r.currentQty ?? 0))
      : (r.currentQty ?? 0);
    const skuDelta = r.itemSku ? (skuAggregateDelta.get(r.itemSku) ?? 0) : totalDelta;
    return {
      ...r,
      projectedQty,
      skuTotalCurrentQty: skuBaseline,
      skuTotalProjectedQty: skuBaseline + skuDelta,
    };
  });

  // Totals include unmapped inventory lines too — they're still part of
  // the PO's inventory dollar value even before the user has decided
  // which internal item each one maps to. Skipped + non-inventory lines
  // are excluded since they won't post to stock or count toward the
  // inventory portion of the PO.
  const inventoryRows = rows.filter(
    (r) => r.status === 'mapped' || r.status === 'unmapped',
  );
  const summary: PreviewSummary = {
    mappedCount: rows.filter((r) => r.status === 'mapped').length,
    unmappedCount: rows.filter((r) => r.status === 'unmapped').length,
    skippedCount: rows.filter((r) => r.status === 'skipped').length,
    nonInventoryCount: rows.filter((r) => r.status === 'non-inventory').length,
    totalUnits: inventoryRows.reduce((sum, r) => sum + r.qty, 0),
    totalCost: inventoryRows.reduce((sum, r) => sum + r.cost, 0),
  };

  return { rows, summary };
}

export function StockImpactPreview({
  lines,
  overrides,
  items,
  skuTotalBySku,
}: StockImpactPreviewProps) {
  const { rows, summary } = React.useMemo(
    () => buildPreview(lines, overrides, items, skuTotalBySku),
    [lines, overrides, items, skuTotalBySku],
  );

  const mapped = rows.filter((r) => r.status === 'mapped');
  const unmapped = rows.filter((r) => r.status === 'unmapped');
  const skipped = rows.filter((r) => r.status === 'skipped' || r.status === 'non-inventory');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Package className="text-muted-foreground h-4 w-4" />
        <h2 className="text-sm font-semibold">Stock impact preview</h2>
        <span className="text-muted-foreground text-xs">
          What will be added when this PO is received. Adjust above before approving.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryStat
          label="Items affected"
          value={formatNumber(summary.mappedCount)}
          tone="default"
          icon={CheckCircle2}
        />
        <SummaryStat
          label="Units inbound"
          value={formatNumber(summary.totalUnits)}
          tone="default"
          icon={ArrowRight}
        />
        <SummaryStat
          label="Unmapped"
          value={formatNumber(summary.unmappedCount)}
          tone={summary.unmappedCount > 0 ? 'warn' : 'default'}
          icon={AlertTriangle}
        />
        <SummaryStat
          label="Total cost"
          value={formatCurrency(summary.totalCost)}
          tone="default"
          icon={Package}
        />
      </div>

      {unmapped.length > 0 && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" />
            {unmapped.length} line{unmapped.length === 1 ? '' : 's'} not mapped to an
            internal item — approve will block until you map or skip these.
          </div>
          <ul className="mt-1 ml-5 list-disc">
            {unmapped.map((r) => (
              <li key={r.lineId}>
                Line {r.lineNumber}: {r.description} ({formatNumber(r.qty)} units)
                {r.projectedQty != null && (
                  <span className="opacity-80">
                    {' '}
                    — will create a new item
                    {r.skuTotalCurrentQty != null && r.skuTotalProjectedQty != null && (
                      <>
                        {' '}
                        (SKU total {formatNumber(r.skuTotalCurrentQty)} →{' '}
                        {formatNumber(r.skuTotalProjectedQty)})
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Internal item</TableHead>
              <TableHead>From PO</TableHead>
              <TableHead
                className="text-right"
                title="Units this line adds to the SKU when received. Which charter owns them is fixed here at import review (Charter for items); the rack is chosen at put-away."
              >
                Adding
              </TableHead>
              <TableHead
                className="text-right"
                title="Total on-hand for this SKU across every charter/rack it lives in, before → after this PO. The units land on the item instance chosen at import review, and the rack at put-away, so only the SKU total is projected here."
              >
                SKU total
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mapped.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-8 text-center text-xs"
                >
                  No inventory lines mapped yet. Pick an internal item for each
                  inventory line above to see the stock impact here.
                </TableCell>
              </TableRow>
            )}
            {mapped.map((r) => (
              <TableRow key={r.lineId}>
                <TableCell className="tabular-nums">{r.lineNumber}</TableCell>
                <TableCell>
                  <div className="font-medium">{r.itemName ?? '—'}</div>
                  <div className="text-muted-foreground font-mono text-[11px]">
                    {r.itemSku ?? '—'}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-[260px] truncate text-xs">
                  {r.description}
                </TableCell>
                <TableCell className="text-success text-right tabular-nums whitespace-nowrap">
                  +{formatNumber(r.qty)} unit{r.qty === 1 ? '' : 's'}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums whitespace-nowrap">
                  {r.skuTotalCurrentQty != null && r.skuTotalProjectedQty != null ? (
                    <>
                      {formatNumber(r.skuTotalCurrentQty)} →{' '}
                      {formatNumber(r.skuTotalProjectedQty)}
                    </>
                  ) : (
                    <span className="text-muted-foreground font-normal">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {skipped.length > 0 && (
        <details className="border-border rounded-md border bg-card px-3 py-2 text-xs">
          <summary className="text-muted-foreground cursor-pointer">
            <MinusCircle className="mr-1 inline h-3 w-3" />
            {skipped.length} line{skipped.length === 1 ? '' : 's'} won't affect stock
            (skipped or non-inventory)
          </summary>
          <ul className="mt-2 space-y-1">
            {skipped.map((r) => (
              <li key={r.lineId} className="text-muted-foreground">
                Line {r.lineNumber} — {r.description}{' '}
                <span className="opacity-60">({r.status})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: 'default' | 'warn';
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div
      className={
        'rounded-md border bg-card px-3 py-2 ' +
        (tone === 'warn' ? 'border-destructive/40' : 'border-border')
      }
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div
        className={
          'mt-1 text-lg font-semibold tabular-nums ' +
          (tone === 'warn' ? 'text-destructive' : '')
        }
      >
        {value}
      </div>
    </div>
  );
}
