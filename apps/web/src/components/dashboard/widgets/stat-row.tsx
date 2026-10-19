import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { Sparkline } from '@/components/ui/sparkline';
import { formatCurrency, formatNumber } from '@/lib/utils';

import { TrendDelta } from './shared';
import type { DashboardWidgetProps, DeltaToken } from './types';

/**
 * The four headline figures: inventory value, items on hand, low/out of
 * stock, movements today, as one stat strip (DESIGN-SPEC 6.8). Each cell keeps
 * its 14-day sparkline and its delta (vs. 30 days ago; movements vs. the 24 h
 * before), all from the page's single read wave.
 */
export function StatRowWidget({
  inventoryValue,
  inventoryValueSeries,
  inventoryValueDelta,
  itemCount,
  itemCountSeries,
  itemCountDelta,
  lowStockCount,
  outOfStockCount,
  lowOutSeries,
  lowOutDelta,
  dailyCounts,
  movementsToday,
  movementsDelta,
  warehouseFilter,
}: DashboardWidgetProps) {
  return (
    // 150 px cells, so a phone shows two figures a row instead of four tiles stacked.
    <StatStrip variant="detail">
      <KeyStat
        label="Inventory value"
        value={formatCurrency(inventoryValue)}
        delta={inventoryValueDelta}
        series={inventoryValueSeries.slice(-14)}
        foot="vs. 30 days ago"
      />
      <KeyStat
        label="Items on hand"
        value={formatNumber(itemCount)}
        delta={itemCountDelta}
        series={itemCountSeries.slice(-14)}
        foot={`${itemCount} active SKUs`}
      />
      <KeyStat
        label="Low / out of stock"
        value={formatNumber(lowStockCount + outOfStockCount)}
        delta={lowOutDelta}
        series={lowOutSeries.slice(-14)}
        foot={`${outOfStockCount} critical · ${lowStockCount} below par`}
      />
      <KeyStat
        label="Movements today"
        value={formatNumber(movementsToday)}
        delta={movementsDelta}
        series={dailyCounts.slice(-14)}
        foot={
          warehouseFilter ? 'in selected warehouse · last 24h' : 'across all locations · last 24h'
        }
      />
    </StatStrip>
  );
}

/**
 * One cell: the label, the figure with its sparkline beside it, then the foot
 * line with the delta at its end. The figure keeps every digit: the
 * sparkline narrows first, and the figure only ends in an ellipsis when it
 * alone is wider than the cell.
 */
function KeyStat({
  label,
  value,
  delta,
  series,
  foot,
}: {
  label: string;
  value: string;
  delta: DeltaToken;
  series: number[];
  foot: string;
}) {
  return (
    <StatStripItem
      data-key-stat={label}
      label={label}
      value={
        <span className="flex min-w-0 items-end justify-between gap-3">
          <span className="max-w-full shrink-0 truncate">{value}</span>
          {series.length > 1 ? (
            <Sparkline
              data={series}
              width={72}
              height={22}
              tone={delta.direction}
              className="mb-1.5 min-w-0 shrink"
            />
          ) : null}
        </span>
      }
      sub={
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0">{foot}</span>
          <TrendDelta delta={delta} />
        </span>
      }
    />
  );
}
