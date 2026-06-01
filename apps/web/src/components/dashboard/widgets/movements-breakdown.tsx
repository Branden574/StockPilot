import { MiniBarChart } from '@/components/dashboard/mini-bar-chart';

import { Card, CardHead } from './shared';
import type { DashboardWidgetProps } from './types';

/**
 * 30-day movement mini-bar chart + the per-type share breakdown. Renders the
 * bare Card (right 3 of 12 cols on lg); the page composes it into the shared
 * chart-row grid next to the inventory-value chart so the default layout is
 * pixel-identical.
 */
export function MovementsBreakdownWidget({ barValues, breakdownRows }: DashboardWidgetProps) {
  return (
    <Card className="lg:col-span-3">
      <CardHead title="Movements · 30 days" subtitle="Receive · sale · transfer · adjust" />
      <div className="px-5 pb-4">
        <MiniBarChart values={barValues} height={120} />
        <hr className="border-border my-4" />
        <div className="flex flex-col gap-3">
          {breakdownRows.length === 0 && (
            <p className="text-muted-foreground py-1 text-[12px]">
              No movements in the last 30 days.
            </p>
          )}
          {breakdownRows.map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-[12.5px]">{r.label}</span>
              <div className="flex items-center gap-2">
                <span
                  className="bg-muted block h-1.5 w-20 overflow-hidden rounded-full"
                  aria-hidden
                >
                  <span
                    className="block h-full rounded-full bg-[var(--ed-ink-2)]"
                    style={{ width: `${r.share * 100}%` }}
                  />
                </span>
                <span className="w-6 text-right font-mono text-[11.5px] tabular-nums text-[var(--ed-ink-3)]">
                  {r.val}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
