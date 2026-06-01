import { BigChart } from '@/components/dashboard/big-chart';

import { Card, CardHead } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Inventory-value-over-30-days line chart. Renders the bare Card (left 9 of 12
 * cols on lg); the page composes it into the shared chart-row grid alongside
 * the movements-breakdown card so the default layout is pixel-identical. When
 * the per-org layout hides/moves it the page falls back to a single-column
 * grid for whichever chart-row widget survives.
 */
export function ValueChartWidget({ valueSeries }: DashboardWidgetProps) {
  return (
    <Card className="lg:col-span-9">
      <CardHead
        title="Inventory value · 30 days"
        subtitle="USD · cost basis · all locations"
        chips={['All locations', 'Cost basis', '+ Compare']}
      />
      <BigChart data={valueSeries} height={300} />
      <div className="flex justify-between px-5 pb-3.5 font-mono text-[11px] text-[var(--ed-ink-4)]">
        <span>30 days ago</span>
        <span>3 weeks ago</span>
        <span>2 weeks ago</span>
        <span>1 week ago</span>
        <span>Today</span>
      </div>
    </Card>
  );
}
