import * as React from 'react';

import { cn } from '@/lib/utils';

import { AnalyticsWidget } from './analytics';
import { GetStartedWidget } from './get-started';
import { MovementsBreakdownWidget } from './movements-breakdown';
import { NeedsAttentionWidget } from './needs-attention';
import { RecentActivityWidget } from './recent-activity';
import { ShiftCommandWidget } from './shift-command';
import { StatRowWidget } from './stat-row';
import { TrendsHeaderWidget } from './trends-header';
import type { DashboardWidgetProps } from './types';
import { ValueChartWidget } from './value-chart';

export type { DashboardWidgetProps } from './types';
export type {
  AttentionItem,
} from './shared';

/**
 * Stable widget-id → component map. Keys MUST match the ids in
 * DASHBOARD_WIDGETS (packages/core). Each component is presentational and
 * reads its slice from the single, already-computed DashboardWidgetProps bag
 * — none of them fetch data, so the page's parallel fan-out is unchanged.
 */
export const WIDGET_COMPONENTS: Record<
  string,
  React.ComponentType<DashboardWidgetProps>
> = {
  'get-started': GetStartedWidget,
  'needs-attention': NeedsAttentionWidget,
  'trends-header': TrendsHeaderWidget,
  'shift-command': ShiftCommandWidget,
  'stat-row': StatRowWidget,
  'value-chart': ValueChartWidget,
  'movements-breakdown': MovementsBreakdownWidget,
  analytics: AnalyticsWidget,
  'recent-activity': RecentActivityWidget,
};

/**
 * value-chart + movements-breakdown share one row when they are adjacent in
 * the resolved order (the default layout): the value card takes 9 of 12
 * columns and the breakdown 3, side by side once the row is wide enough for
 * both (936 px of its own width, the reference's two-column threshold; the
 * row is its own size container, so the sidebar's width counts), stacked
 * before. If only one of them survives a per-org layout (the other hidden), or
 * they end up non-adjacent, each gets a row to itself at full width.
 *
 * The spans live here, not in the widgets: a lone value card used to keep its
 * 9-column span inside the 12-column grid and left a quarter of the row empty.
 */
const CHART_ROW_IDS: ReadonlySet<string> = new Set(['value-chart', 'movements-breakdown']);

const PAIRED_SPAN: Readonly<Record<string, string>> = {
  'value-chart': '@min-[936px]:col-span-9',
  'movements-breakdown': '@min-[936px]:col-span-3',
};

/**
 * Render the resolved, ordered widget ids into the dashboard body. Unknown ids
 * (not in WIDGET_COMPONENTS) are skipped defensively — resolveDashboardWidgets
 * already drops ids absent from the catalog, this is belt-and-suspenders.
 *
 * Consecutive chart-row members are grouped into one shared row so the
 * default layout keeps them side by side; everything else renders standalone
 * in order. The page stacks what this returns 16 px apart.
 */
export function renderDashboardWidgets(
  widgetIds: string[],
  props: DashboardWidgetProps,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];

  for (let i = 0; i < widgetIds.length; i++) {
    const id = widgetIds[i]!;
    const Comp = WIDGET_COMPONENTS[id];
    if (!Comp) continue;

    // Group a run of consecutive chart-row members into a single shared row.
    if (CHART_ROW_IDS.has(id)) {
      const members: string[] = [id];
      while (
        i + 1 < widgetIds.length &&
        CHART_ROW_IDS.has(widgetIds[i + 1]!) &&
        WIDGET_COMPONENTS[widgetIds[i + 1]!]
      ) {
        members.push(widgetIds[i + 1]!);
        i++;
      }
      const paired = members.length > 1;
      out.push(
        <div
          key={`chart-row-${members.join('-')}`}
          data-slot="chart-row"
          data-paired={paired ? 'true' : 'false'}
          className="@container min-w-0"
        >
          <div className={cn('grid grid-cols-1 gap-4', paired && '@min-[936px]:grid-cols-12')}>
            {members.map((mid) => {
              const M = WIDGET_COMPONENTS[mid]!;
              return (
                <div
                  key={mid}
                  data-widget={mid}
                  className={cn('flex min-w-0 flex-col', paired && PAIRED_SPAN[mid])}
                >
                  <M {...props} />
                </div>
              );
            })}
          </div>
        </div>,
      );
      continue;
    }

    out.push(<Comp key={id} {...props} />);
  }

  return out;
}
