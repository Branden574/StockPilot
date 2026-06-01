import { AnalyticsSection } from '@/components/dashboard/charts/analytics-section';

import type { DashboardWidgetProps } from './types';

/**
 * Analytics — the lazy Recharts island. Section header + AnalyticsSection,
 * which lazy-loads the Recharts grid client-side (next/dynamic, ssr:false)
 * with a skeleton fallback, so this heavy client-only payload hydrates AFTER
 * the shell + table stream and paint. The data is already mapped to
 * JSON-serializable series on the server (props.analytics). Keeping the lazy
 * island intact preserves the dashboard load-perf work — do NOT inline the
 * grid here.
 */
export function AnalyticsWidget({ analytics }: DashboardWidgetProps) {
  return (
    <>
      <div className="mt-2 mb-4 flex items-end justify-between gap-3 border-b border-border pb-2">
        <div>
          <h2 className="font-display text-[18px] font-medium tracking-[-0.015em]">Analytics</h2>
          <p className="text-[12px] text-[var(--ed-ink-3)]">
            Value trend, composition, and movement volume.
          </p>
        </div>
      </div>
      <div className="mb-4">
        <AnalyticsSection
          valueSeries={analytics.valueSeries}
          byCategory={analytics.byCategory}
          byWarehouse={analytics.byWarehouse}
          movementBars={analytics.movementBars}
        />
      </div>
    </>
  );
}
