import { AlertTriangle, ArrowUpRight, ClipboardCheck, ClipboardList, Zap } from 'lucide-react';

import { DetailSection } from '@/components/patterns/detail-section';
import { StatStrip, StatStripItem } from '@/components/patterns/stat-strip';
import { formatNumber } from '@/lib/utils';

import { QuickAction } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * Shift command — fast paths for the next inventory action. A card in the
 * Overview's language: the "Live" pill in its header, the SKUs / Low / Out
 * readouts as a small stat strip, then the five quick actions. The quick
 * actions are not role-filtered (as before); the counts are the page's own.
 */
export function ShiftCommandWidget({
  itemCount,
  lowStockCount,
  outOfStockCount,
  openPoCount,
  openCycleCount,
}: DashboardWidgetProps) {
  return (
    <aside className="min-w-0">
      <DetailSection
        title="Shift command"
        aside={
          <span className="border-line-strong text-muted-foreground inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[12px]">
            <span aria-hidden className="bg-accent size-[5px] rounded-full" />
            Live
          </span>
        }
      >
        <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">
          Fast paths for the next inventory action.
        </p>

        <StatStrip variant="detail" className="mt-3">
          <StatStripItem size="detail" label="SKUs" value={formatNumber(itemCount)} />
          <StatStripItem size="detail" label="Low" value={formatNumber(lowStockCount)} />
          <StatStripItem size="detail" label="Out" value={formatNumber(outOfStockCount)} />
        </StatStrip>

        {/* At most three links to a row (3 + 2). The Overview's page box
            stops at 1320 px, so this grid is never wider than about 1218 px,
            and five to a row (from 1180 px) cut "Open purchase orders" and
            "Cycle counts in progress" with their counts at every window from
            about 1510 px up (P68-04). The steps keep every link at least
            about 258 px wide, (528 - 8) / 2 and (792 - 16) / 3: "Cycle
            counts in progress" with its count needs about 251 px, and two
            from a 480 px grid or three from 760 px left links of 237 to
            249 px just past each step, which cut it at windows of 552 to
            576, 812 to 836 (a tablet in portrait, sidebar pinned) and 1092
            to 1096 px. */}
        <div className="@container mt-3">
          <div className="@min-[528px]:grid-cols-2 @min-[792px]:grid-cols-3 grid gap-2">
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
        </div>
      </DetailSection>
    </aside>
  );
}
