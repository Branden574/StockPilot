'use client';

import { ChartCard } from './chart-card';
import { InventoryBreakdownWidget } from './inventory-breakdown-widget';
import { InventoryValueWidget, type ValuePoint, type ValueRange } from './inventory-value-widget';
import { MovementVolumeWidget } from './movement-volume-widget';
import type { BreakdownSlice, MovementBar } from './widget-data';

export interface AnalyticsGridProps {
  valueSeries: Partial<Record<ValueRange, ValuePoint[]>>;
  byCategory: BreakdownSlice[];
  byWarehouse: BreakdownSlice[];
  movementBars: MovementBar[];
}

/**
 * Arranges the three analytics widgets in a responsive grid. This is the
 * heavy, Recharts-dependent payload — loaded as a lazy client island by
 * AnalyticsSection so the dashboard shell + table stream and paint first.
 *
 * The columns follow the Analytics widget's own width (its wrapper is the size
 * container): two side by side once there is room for both, stacked before.
 *
 * The widgets themselves are composable (each takes data+config props), so
 * Phase 2 can swap this fixed grid for a configurable layout without
 * touching the widget components.
 */
export function AnalyticsGrid({
  valueSeries,
  byCategory,
  byWarehouse,
  movementBars,
}: AnalyticsGridProps) {
  return (
    <div className="@min-[936px]:grid-cols-12 grid grid-cols-1 gap-4">
      <ChartCard
        headingLevel={3}
        className="@min-[936px]:col-span-8"
        title="Inventory value over time"
        subtitle="USD · cost basis · approximate (reverse-walked)"
      >
        <div className="px-[18px] pb-4 pt-3">
          <InventoryValueWidget series={valueSeries} />
        </div>
      </ChartCard>

      <ChartCard
        headingLevel={3}
        className="@min-[936px]:col-span-4"
        title="Value breakdown"
        subtitle="Cost basis by category or warehouse"
      >
        <div className="px-[18px] pb-4 pt-3">
          <InventoryBreakdownWidget byCategory={byCategory} byWarehouse={byWarehouse} />
        </div>
      </ChartCard>

      <ChartCard
        headingLevel={3}
        className="@min-[936px]:col-span-12"
        title="Movement volume · 30 days"
        subtitle="Count of stock movements by type"
      >
        <div className="px-[18px] pb-4 pt-3">
          <MovementVolumeWidget bars={movementBars} />
        </div>
      </ChartCard>
    </div>
  );
}
