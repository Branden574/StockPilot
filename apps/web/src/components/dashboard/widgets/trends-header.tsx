import { formatCurrency, formatNumber } from '@/lib/utils';

import { StatusMetric } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Section header for the 30-day-trends block + the four status readouts
 * (health / critical / avg value-per-SKU / 7-day activity) that ride along
 * its right edge on >= sm.
 */
export function TrendsHeaderWidget({
  healthRate,
  attentionStockCount,
  outOfStockCount,
  valuePerSku,
  movements7d,
}: DashboardWidgetProps) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3 border-b border-border pb-2">
      <div>
        <h2 className="font-display text-[18px] font-medium tracking-[-0.015em]">
          30-day trends
        </h2>
        <p className="text-[12px] text-[var(--ed-ink-3)]">
          Inventory value, on-hand counts, and movement velocity over the last month.
        </p>
      </div>
      <div className="hidden grid-cols-4 gap-2 sm:grid sm:max-w-xl sm:flex-1">
        <StatusMetric
          label="Health"
          value={`${healthRate}%`}
          tone={attentionStockCount > 0 ? 'warn' : 'good'}
        />
        <StatusMetric label="Critical" value={formatNumber(outOfStockCount)} tone="danger" />
        <StatusMetric label="Avg value / SKU" value={formatCurrency(valuePerSku)} />
        <StatusMetric label="Activity (7d)" value={formatNumber(movements7d)} />
      </div>
    </div>
  );
}
