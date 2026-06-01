'use client';

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
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-12">
      <Panel
        className="lg:col-span-8"
        title="Inventory value over time"
        subtitle="USD · cost basis · approximate (reverse-walked)"
      >
        <InventoryValueWidget series={valueSeries} />
      </Panel>

      <Panel
        className="lg:col-span-4"
        title="Value breakdown"
        subtitle="Cost basis by category or warehouse"
      >
        <InventoryBreakdownWidget byCategory={byCategory} byWarehouse={byWarehouse} />
      </Panel>

      <Panel
        className="lg:col-span-12"
        title="Movement volume · 30 days"
        subtitle="Count of stock movements by type"
      >
        <MovementVolumeWidget bars={movementBars} />
      </Panel>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        'border-border bg-card overflow-hidden rounded-lg border shadow-[0_10px_34px_rgba(14,15,13,0.045)] ' +
        (className ?? '')
      }
    >
      <div className="border-border border-b px-5 py-3.5">
        <div className="font-display text-[14px] font-medium tracking-[-0.01em]">{title}</div>
        {subtitle && <div className="text-[12px] text-[var(--ed-ink-3)]">{subtitle}</div>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}
