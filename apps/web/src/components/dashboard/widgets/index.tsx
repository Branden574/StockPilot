import * as React from 'react';

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
 * value-chart + movements-breakdown share one `grid lg:grid-cols-12` row in
 * the default layout (9/12 + 3/12, side-by-side on lg). Both widgets render a
 * BARE Card with their col-span class; the renderer below wraps them so the
 * default order paints pixel-identically to the pre-refactor page. If only one
 * of them survives a per-org layout (the other hidden), or they end up
 * non-adjacent, each still gets its own single-column grid and renders
 * correctly on its own.
 */
const CHART_ROW_IDS: ReadonlySet<string> = new Set(['value-chart', 'movements-breakdown']);

/**
 * Render the resolved, ordered widget ids into the dashboard body. Unknown ids
 * (not in WIDGET_COMPONENTS) are skipped defensively — resolveDashboardWidgets
 * already drops ids absent from the catalog, this is belt-and-suspenders.
 *
 * Consecutive chart-row members are grouped into one 12-col grid so the
 * default layout is unchanged; everything else renders standalone in order.
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

    // Group a run of consecutive chart-row members into a single shared grid.
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
      out.push(
        <div
          key={`chart-row-${members.join('-')}`}
          className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12"
        >
          {members.map((mid) => {
            const M = WIDGET_COMPONENTS[mid]!;
            return <M key={mid} {...props} />;
          })}
        </div>,
      );
      continue;
    }

    out.push(<Comp key={id} {...props} />);
  }

  return out;
}
