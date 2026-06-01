'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { cn } from '@/lib/utils';

import type { MovementBar } from './widget-data';

const CHART_CONFIG = {
  count: {
    label: 'Movements',
    color: 'hsl(var(--chart-1))',
  },
} satisfies ChartConfig;

export interface MovementVolumeWidgetProps {
  /** Pre-mapped bars (from toMovementBars). One per movement type, sorted
   *  by count descending. */
  bars: MovementBar[];
  className?: string;
  /** Chart drawing height in px. Defaults to 240. */
  height?: number;
}

/**
 * Self-contained 30-day movement-volume bar chart, grouped by movement type.
 * Fed by `toMovementBars(getThirtyDayMetrics(...))` mapped on the server.
 * Phase 2 reuses this with its own bar data.
 */
export function MovementVolumeWidget({ bars, className, height = 240 }: MovementVolumeWidgetProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      {bars.length === 0 ? (
        <p className="text-muted-foreground flex h-[200px] items-center justify-center text-[12.5px]">
          No movements in the last 30 days.
        </p>
      ) : (
        <ChartContainer config={CHART_CONFIG} className="aspect-auto w-full" style={{ height }}>
          <BarChart
            data={bars}
            margin={{ left: 4, right: 8, top: 8, bottom: 0 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={0}
            />
            <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={[4, 4, 0, 0]} maxBarSize={56} />
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
