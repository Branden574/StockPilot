import { Fragment } from 'react';

import { ChartCard } from '@/components/dashboard/charts/chart-card';
import { MiniBarChart } from '@/components/dashboard/mini-bar-chart';

import type { DashboardWidgetProps } from './types';

/**
 * 30-day movement mini-bar chart + the per-type share breakdown, in the value
 * card's chart-card look. The widget renderer (index.tsx) sets it beside the
 * inventory-value card when the two are adjacent, full width on its own.
 */
export function MovementsBreakdownWidget({ barValues, breakdownRows }: DashboardWidgetProps) {
  return (
    <ChartCard
      title="Movements · 30 days"
      subtitle="Receive · sale · transfer · adjust"
      className="flex-1"
    >
      <div className="px-[18px] pb-4 pt-4">
        <MiniBarChart values={barValues} height={120} />
        <hr className="border-border my-4" />
        <div className="flex flex-col gap-3">
          {breakdownRows.length === 0 && (
            <p className="text-muted-foreground py-1 text-[12.5px]">
              No movements in the last 30 days.
            </p>
          )}
          {breakdownRows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3">
              {/* A long type such as Bundle_assembly may only wrap after an
                  underscore (a <wbr> there), never mid-word; the text stays
                  the same label. */}
              <span className="min-w-0 break-words text-[12.5px]">
                {r.label.split('_').map((part, i, all) => (
                  <Fragment key={i}>
                    {part}
                    {i < all.length - 1 ? (
                      <>
                        _<wbr />
                      </>
                    ) : null}
                  </Fragment>
                ))}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="bg-line-strong block h-1 w-12 overflow-hidden rounded-[2px]"
                  aria-hidden
                >
                  <span
                    className="bg-ink-2 block h-full rounded-[2px]"
                    style={{ width: `${r.share * 100}%` }}
                  />
                </span>
                <span className="text-muted-foreground w-8 text-right font-mono text-[11.5px] tabular-nums">
                  {r.val}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ChartCard>
  );
}
