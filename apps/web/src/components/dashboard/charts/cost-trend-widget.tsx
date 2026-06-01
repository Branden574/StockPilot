'use client';

import * as React from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { cn, formatCurrency } from '@/lib/utils';

import type { SupplierCostSeries } from '@/server/services/reports';

// Five-hue rotation from the editorial chart palette (matches the breakdown
// donut). One color per supplier line; beyond five suppliers the palette
// recycles — acceptable since the legend disambiguates by name.
const PALETTE = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

export interface CostTrendWidgetProps {
  /**
   * Per-supplier cost series, already chronological per supplier (from
   * ReportsService.itemCostHistory(...).series). Self-contained: hand it
   * the data and it renders. Phase 2 can drop this on any layout.
   */
  series: SupplierCostSeries[];
  className?: string;
  /** Chart drawing height in px. Defaults to 240. */
  height?: number;
}

/**
 * A row in the merged chart dataset: one X position (a date) carrying a
 * unit-cost value per supplier key that has an observation on that date.
 * Missing keys are left undefined so Recharts gaps the line (connectNulls).
 */
type MergedRow = { date: string; label: string } & Record<string, number | string | undefined>;

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

/**
 * Merge per-supplier point arrays into a single, date-sorted dataset keyed by
 * `s{i}` per supplier so each becomes its own <Line>. Kept inside the client
 * widget (it depends on the supplier→color index) and memoized by the caller.
 */
function toMergedRows(series: SupplierCostSeries[]): MergedRow[] {
  const byDate = new Map<string, MergedRow>();
  series.forEach((s, i) => {
    const key = `s${i}`;
    for (const p of s.points) {
      const row = byDate.get(p.date) ?? { date: p.date, label: dateLabel(p.date) };
      // If a supplier has two observations on the exact same date (e.g. a PO
      // and a same-day receipt), the later write wins — a single point per
      // (supplier, date) is the right granularity for a trend line.
      row[key] = p.unitCost;
      byDate.set(p.date, row);
    }
  });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Multi-series line chart of the unit cost we've paid for an item over time,
 * one line per supplier. Fed by ReportsService.itemCostHistory — built from
 * our own PO + receipt unit_cost data (no external pricing). Self-contained
 * and composable so it works on the item-detail page today and as a dashboard
 * widget in Phase 2.
 */
export function CostTrendWidget({ series, className, height = 240 }: CostTrendWidgetProps) {
  const rows = React.useMemo(() => toMergedRows(series), [series]);

  const config = React.useMemo<ChartConfig>(() => {
    const c: ChartConfig = {};
    series.forEach((s, i) => {
      c[`s${i}`] = { label: s.supplierName, color: PALETTE[i % PALETTE.length] };
    });
    return c;
  }, [series]);

  const totalPoints = series.reduce((n, s) => n + s.points.length, 0);

  // A single isolated observation can't draw a line. Still chart it (the dot
  // shows), but two-or-more is when the trend reads. Empty → friendly note.
  if (totalPoints === 0) {
    return (
      <p className="text-muted-foreground flex h-[180px] items-center justify-center text-center text-[12.5px]">
        No purchase or receipt cost recorded for this item yet.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
        <LineChart data={rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={28}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => formatCurrency(v).replace(/\.00$/, '')}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelKey="label"
                formatter={(value, name, item) => {
                  const color = item?.color as string | undefined;
                  return (
                    <span className="flex w-full items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5">
                        {color && (
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: color }}
                          />
                        )}
                        <span>{config[name as string]?.label ?? name}</span>
                      </span>
                      <span className="font-mono tabular-nums">{formatCurrency(Number(value))}</span>
                    </span>
                  );
                }}
              />
            }
          />
          {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((_s, i) => (
            <Line
              key={`s${i}`}
              dataKey={`s${i}`}
              type="monotone"
              stroke={`var(--color-s${i})`}
              strokeWidth={1.8}
              dot={{ r: 2.5 }}
              activeDot={{ r: 4 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
