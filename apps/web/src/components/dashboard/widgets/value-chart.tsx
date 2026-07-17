import { ValueChartInteractive } from './value-chart-interactive';
import type { DashboardWidgetProps } from './types';

/**
 * Inventory-value line chart. Now a thin server wrapper (Unit C): it hands the
 * server-rendered default series + the already-fetched warehouse list to the
 * interactive client island, which owns the Card chrome, controls (location /
 * basis / compare), and all on-demand fetching. The default view still renders
 * from the SSR seed with ZERO extra fetches on dashboard load — the island only
 * fetches when the operator changes a control.
 *
 * The page composes this into the shared chart-row grid via the `lg:col-span-9`
 * class forwarded to the island's Card, so the default layout is pixel-identical.
 */
export function ValueChartWidget({
  valueSeries,
  warehouses,
  warehouseFilter,
}: DashboardWidgetProps) {
  return (
    <ValueChartInteractive
      className="lg:col-span-9"
      initialSeries={valueSeries}
      warehouses={warehouses}
      initialWarehouseId={warehouseFilter}
    />
  );
}
