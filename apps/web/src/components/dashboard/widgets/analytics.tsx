import { AnalyticsSection } from '@/components/dashboard/charts/analytics-section';

import { WidgetHeading } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Analytics — the lazy Recharts island. Section header + AnalyticsSection,
 * which lazy-loads the Recharts grid client-side (next/dynamic, ssr:false)
 * with a skeleton fallback, so this heavy client-only payload hydrates AFTER
 * the shell + table stream and paint. The data is already mapped to
 * JSON-serializable series on the server (props.analytics). Keeping the lazy
 * island intact preserves the dashboard load-perf work — do NOT inline the
 * grid here.
 *
 * The wrapper is the size container the grid lays out against (its columns
 * follow the space beside the sidebar, not the window).
 */
export function AnalyticsWidget({ analytics }: DashboardWidgetProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WidgetHeading
        title="Analytics"
        description="Value trend, composition, and movement volume."
      />
      <div className="@container min-w-0">
        <AnalyticsSection
          valueSeries={analytics.valueSeries}
          byCategory={analytics.byCategory}
          byWarehouse={analytics.byWarehouse}
          movementBars={analytics.movementBars}
        />
      </div>
    </div>
  );
}
