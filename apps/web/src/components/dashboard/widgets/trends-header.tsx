import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { formatCurrency, formatNumber } from '@/lib/utils';

import { WidgetHeading } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Section header for the 30-day-trends block + the four status readouts
 * (health / critical / avg value-per-SKU / 7-day activity), drawn as the
 * reference's stat strip (DESIGN-SPEC 6.8) under the heading.
 */
export function TrendsHeaderWidget({
  healthRate,
  attentionStockCount,
  outOfStockCount,
  valuePerSku,
  movements7d,
}: DashboardWidgetProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WidgetHeading
        title="30-day trends"
        description="Inventory value, on-hand counts, and movement velocity over the last month."
      />
      {/* The readouts show from lg up, as they always have: below it the same
          numbers live in the key stats and the attention list. */}
      <StatStrip data-widget-part="trend-readouts" className="hidden lg:block">
        <StatStripItem
          label="Health"
          value={`${healthRate}%`}
          valueTone={attentionStockCount > 0 ? 'warning' : 'accent'}
        />
        <StatStripItem
          label="Critical"
          value={formatNumber(outOfStockCount)}
          valueTone="destructive"
        />
        <StatStripItem label="Avg value / SKU" value={formatCurrency(valuePerSku)} />
        <StatStripItem label="Activity (7d)" value={formatNumber(movements7d)} />
      </StatStrip>
    </div>
  );
}
