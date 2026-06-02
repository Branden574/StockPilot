'use client';

import * as React from 'react';
import { Cell, Pie, PieChart } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';

import { ToggleGroup } from './toggle-group';
import type { BreakdownDimension, BreakdownSlice } from './widget-data';

// Five-hue rotation from the editorial chart palette. Slices beyond five
// recycle the palette — acceptable for a high-level breakdown where the long
// tail is small. The legend/tooltip name disambiguates same-colored slices.
const PALETTE = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

export interface InventoryBreakdownWidgetProps {
  /** Pre-mapped slices by dimension (from toBreakdownSlices). */
  byCategory: BreakdownSlice[];
  byWarehouse: BreakdownSlice[];
  /** Initial dimension. Defaults to 'category'. */
  defaultDimension?: BreakdownDimension;
  className?: string;
  /** Chart drawing height in px. Defaults to 280. */
  height?: number;
}

/**
 * Self-contained value-breakdown donut. Toggles between value-by-category and
 * value-by-warehouse. Fed by `toBreakdownSlices(inventoryValuation(), dim)`
 * mapped on the server. Renders a center total and a legend with dollar
 * shares. Phase 2 reuses this with its own slice data.
 */
export function InventoryBreakdownWidget({
  byCategory,
  byWarehouse,
  defaultDimension = 'category',
  className,
  height = 280,
}: InventoryBreakdownWidgetProps) {
  const [dimension, setDimension] = React.useState<BreakdownDimension>(defaultDimension);
  const slices = dimension === 'warehouse' ? byWarehouse : byCategory;

  const total = React.useMemo(() => slices.reduce((s, x) => s + x.value, 0), [slices]);

  // Build a ChartConfig keyed by slice key so the tooltip resolves labels.
  const config = React.useMemo<ChartConfig>(() => {
    const c: ChartConfig = {};
    slices.forEach((s, i) => {
      c[s.key] = { label: s.name, color: PALETTE[i % PALETTE.length] };
    });
    return c;
  }, [slices]);

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="mb-2 flex items-center justify-end">
        <ToggleGroup
          aria-label="Breakdown dimension"
          options={[
            { value: 'category', label: 'By category' },
            { value: 'warehouse', label: 'By warehouse' },
          ]}
          value={dimension}
          onChange={(v) => setDimension(v as BreakdownDimension)}
        />
      </div>

      {slices.length === 0 ? (
        <p className="text-muted-foreground flex h-[200px] items-center justify-center text-[12.5px]">
          No valued inventory to break down.
        </p>
      ) : (
        <>
          <ChartContainer config={config} className="mx-auto aspect-auto w-full" style={{ height }} chartHeight={height}>
            <PieChart>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    nameKey="name"
                    formatter={(value) => formatCurrency(Number(value))}
                  />
                }
              />
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="55%"
                outerRadius="80%"
                paddingAngle={1.5}
                strokeWidth={1}
              >
                {slices.map((s, i) => (
                  <Cell key={s.key} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>

          <div className="mt-1 text-center">
            <div className="font-display text-[18px] font-medium tabular-nums leading-none">
              {formatCurrency(total)}
            </div>
            <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.08em] text-[var(--ed-ink-4)]">
              Total value
            </div>
          </div>

          <ul className="mt-3 flex flex-col gap-1.5">
            {slices.slice(0, 6).map((s, i) => {
              const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
              return (
                <li key={s.key} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                    />
                    <span className="truncate">{s.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
                    <span>{formatCurrency(s.value)}</span>
                    <span className="w-8 text-right">{pct}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
