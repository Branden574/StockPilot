import { ValueChartInteractive } from './value-chart-interactive';
import type { DashboardWidgetProps } from './types';

/**
 * Inventory-value line chart. A thin server wrapper (Unit C): it hands the
 * server-rendered default series, the already-fetched warehouse list and the
 * key stats' own inventory value and delta to the interactive client island,
 * which owns the card, its controls (location / basis / compare) and all
 * on-demand fetching. The default view still renders from the SSR seed with
 * ZERO extra fetches on dashboard load — the island only fetches when the
 * operator changes a control.
 *
 * The widget renderer (index.tsx) places it: beside the movements breakdown
 * when the two are adjacent, full width on its own.
 */
export function ValueChartWidget({
  valueSeries,
  warehouses,
  warehouseFilter,
  inventoryValue,
  inventoryValueDelta,
}: DashboardWidgetProps) {
  return (
    <ValueChartInteractive
      className="flex-1"
      initialSeries={valueSeries}
      warehouses={warehouses}
      initialWarehouseId={warehouseFilter}
      initialValue={inventoryValue}
      initialDelta={inventoryValueDelta}
    />
  );
}
