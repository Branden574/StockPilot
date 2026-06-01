import { Activity, AlertTriangle, DollarSign, PackageCheck } from 'lucide-react';

import { StatCard } from '@/components/dashboard/stat-card';
import { formatCurrency, formatNumber } from '@/lib/utils';

import type { DashboardWidgetProps } from './types';

/**
 * The four headline StatCards: inventory value, items on hand, low/out of
 * stock, movements today. Each shows a 14-day sparkline + a delta token vs.
 * 30 days ago (movements vs. yesterday).
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
    <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Inventory value"
        value={formatCurrency(inventoryValue)}
        delta={{ value: inventoryValueDelta.label, direction: inventoryValueDelta.direction }}
        series={inventoryValueSeries.slice(-14)}
        foot="vs. 30 days ago"
        icon={DollarSign}
      />
      <StatCard
        label="Items on hand"
        value={formatNumber(itemCount)}
        delta={{ value: itemCountDelta.label, direction: itemCountDelta.direction }}
        series={itemCountSeries.slice(-14)}
        foot={`${itemCount} active SKUs`}
        icon={PackageCheck}
      />
      <StatCard
        label="Low / out of stock"
        value={formatNumber(lowStockCount + outOfStockCount)}
        delta={{ value: lowOutDelta.label, direction: lowOutDelta.direction }}
        series={lowOutSeries.slice(-14)}
        foot={`${outOfStockCount} critical · ${lowStockCount} below par`}
        icon={AlertTriangle}
      />
      <StatCard
        label="Movements today"
        value={formatNumber(movementsToday)}
        delta={{ value: movementsDelta.label, direction: movementsDelta.direction }}
        series={dailyCounts.slice(-14)}
        foot={
          warehouseFilter ? 'in selected warehouse · last 24h' : 'across all locations · last 24h'
        }
        icon={Activity}
      />
    </div>
  );
}
