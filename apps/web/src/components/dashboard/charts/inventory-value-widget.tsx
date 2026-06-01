'use client';

import * as React from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatCurrency } from '@/lib/utils';
import { cn } from '@/lib/utils';

import { ToggleGroup } from './toggle-group';
import type { ValuePoint } from './widget-data';

export type { ValuePoint } from './widget-data';

export type ValueChartType = 'line' | 'area';
export type ValueRange = 30 | 90;

const CHART_CONFIG = {
  value: {
    label: 'Inventory value',
    color: 'hsl(var(--chart-1))',
  },
} satisfies ChartConfig;

export interface InventoryValueWidgetProps {
  /**
   * Pre-mapped points for each supported range. The widget toggles which
   * series it renders client-side without re-fetching, so the dashboard can
   * fetch both ranges once on the server. If a range is omitted it's hidden
   * from the toggle.
   */
  series: Partial<Record<ValueRange, ValuePoint[]>>;
  /** Initial chart type. Defaults to 'area'. */
  defaultType?: ValueChartType;
  /** Initial range. Defaults to the smallest range present. */
  defaultRange?: ValueRange;
  className?: string;
  /** Chart drawing height in px. Defaults to 280. */
  height?: number;
}

const RANGE_LABEL: Record<ValueRange, string> = { 30: '30d', 90: '90d' };

/**
 * Self-contained inventory-value-over-time widget. Line/area toggle + range
 * toggle (30d/90d). Fed by `toValueSeries(getDashboardHistory(...))` mapped on
 * the server. Phase 2 can drop this anywhere it has the `series` prop.
 *
 * 365d is intentionally not offered — see HistoryRangeDays in movements.ts.
 */
export function InventoryValueWidget({
  series,
  defaultType = 'area',
  defaultRange,
  className,
  height = 280,
}: InventoryValueWidgetProps) {
  const availableRanges = React.useMemo(
    () => (Object.keys(series) as unknown as string[]).map(Number).sort((a, b) => a - b) as ValueRange[],
    [series],
  );
  const initialRange = defaultRange && series[defaultRange] ? defaultRange : (availableRanges[0] ?? 30);

  const [type, setType] = React.useState<ValueChartType>(defaultType);
  const [range, setRange] = React.useState<ValueRange>(initialRange);

  const data = series[range] ?? [];
  const currency = (v: number) => formatCurrency(v);

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="mb-2 flex items-center justify-end gap-2">
        <ToggleGroup
          aria-label="Range"
          options={availableRanges.map((r) => ({ value: String(r), label: RANGE_LABEL[r] }))}
          value={String(range)}
          onChange={(v) => setRange(Number(v) as ValueRange)}
        />
        <ToggleGroup
          aria-label="Chart type"
          options={[
            { value: 'area', label: 'Area' },
            { value: 'line', label: 'Line' },
          ]}
          value={type}
          onChange={(v) => setType(v as ValueChartType)}
        />
      </div>

      {data.length < 2 ? (
        <p className="text-muted-foreground flex h-[200px] items-center justify-center text-[12.5px]">
          Not enough history to chart yet.
        </p>
      ) : (
        <ChartContainer config={CHART_CONFIG} className="aspect-auto w-full" style={{ height }}>
          {type === 'area' ? (
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="2 4" />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatCurrency(v).replace(/\.00$/, '')}
              />
              <ChartTooltip
                content={<ChartTooltipContent formatter={(value) => currency(Number(value))} />}
              />
              <Area
                dataKey="value"
                type="monotone"
                fill="var(--color-value)"
                fillOpacity={0.12}
                stroke="var(--color-value)"
                strokeWidth={1.8}
              />
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="2 4" />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={28}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => formatCurrency(v).replace(/\.00$/, '')}
              />
              <ChartTooltip
                content={<ChartTooltipContent formatter={(value) => currency(Number(value))} />}
              />
              <Line
                dataKey="value"
                type="monotone"
                stroke="var(--color-value)"
                strokeWidth={1.8}
                dot={false}
              />
            </LineChart>
          )}
        </ChartContainer>
      )}
    </div>
  );
}
