import { AlertTriangle, ArrowUpRight, ClipboardCheck, ClipboardList, Zap } from 'lucide-react';

import { formatNumber } from '@/lib/utils';

import { MiniReadout, QuickAction } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Shift command — fast paths for the next inventory action. Sits below the
 * hero so the morning glance reads top-to-bottom: who/why first, then
 * "where to click next".
 */
export function ShiftCommandWidget({
  itemCount,
  lowStockCount,
  outOfStockCount,
  openPoCount,
  openCycleCount,
}: DashboardWidgetProps) {
  return (
    <aside className="mb-4 bg-card rounded-lg border border-[var(--ed-line-strong)] p-4 shadow-[0_14px_44px_rgba(14,15,13,0.06)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-display text-[14px] font-medium tracking-[-0.01em]">
            Shift command
          </div>
          <p className="mt-0.5 text-[12px] text-[var(--ed-ink-3)]">
            Fast paths for the next inventory action.
          </p>
        </div>
        <span className="border-border bg-background inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] text-[var(--ed-ink-3)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />
          Live
        </span>
      </div>

      <div className="divide-border border-border bg-background mt-4 grid grid-cols-3 divide-x overflow-hidden rounded-md border">
        <MiniReadout label="SKUs" value={formatNumber(itemCount)} />
        <MiniReadout label="Low" value={formatNumber(lowStockCount)} />
        <MiniReadout label="Out" value={formatNumber(outOfStockCount)} />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <QuickAction
          href="/dashboard/inventory?stock=low&type=all"
          icon={AlertTriangle}
          label="Review low stock"
          badge={
            lowStockCount + outOfStockCount > 0
              ? formatNumber(lowStockCount + outOfStockCount)
              : undefined
          }
        />
        <QuickAction
          href="/dashboard/purchase-orders"
          icon={ClipboardList}
          label="Open purchase orders"
          badge={openPoCount > 0 ? formatNumber(openPoCount) : undefined}
        />
        <QuickAction
          href="/dashboard/cycle-counts"
          icon={ClipboardCheck}
          label="Cycle counts in progress"
          badge={openCycleCount > 0 ? formatNumber(openCycleCount) : undefined}
        />
        <QuickAction
          href="/dashboard/purchase-orders/new"
          icon={Zap}
          label="Create receiving run"
        />
        <QuickAction href="/dashboard/reports" icon={ArrowUpRight} label="Open reports" />
      </div>
    </aside>
  );
}
