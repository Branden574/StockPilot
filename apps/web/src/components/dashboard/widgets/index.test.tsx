import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DASHBOARD_WIDGETS,
  resolveDashboardWidgets,
  type DashboardLayout,
} from '@stockpilot/core';

import { renderDashboardWidgets } from './index';
import type { DashboardWidgetProps } from './types';

// next/link is a client navigation primitive — render as a plain anchor.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

// The analytics widget mounts the lazy Recharts island (next/dynamic, ssr:false).
// Stub it so the body renders without dragging Recharts into the test bundle —
// the test only cares about widget PRESENCE + ORDER, not the chart internals.
vi.mock('@/components/dashboard/charts/analytics-section', () => ({
  AnalyticsSection: () => <div data-testid="analytics-island" />,
}));

// BigChart needs ResizeObserver (client-only); stub to keep the value-chart
// widget renderable in happy-dom without it.
vi.mock('@/components/dashboard/big-chart', () => ({
  BigChart: () => <div data-testid="big-chart" />,
}));

const ALL_IDS = DASHBOARD_WIDGETS.map((w) => w.id);

/**
 * A fully-populated props bag so every widget renders its non-empty branch.
 * checklistComplete=false so the get-started widget renders (its in-widget gate
 * only suppresses when the checklist is done — see GetStartedWidget).
 */
function makeProps(overrides: Partial<DashboardWidgetProps> = {}): DashboardWidgetProps {
  const delta = { label: '+1', direction: 'up' as const };
  return {
    checklistSteps: [
      { id: 'a', done: false, title: 'Step A', description: 'd', href: '/a', cta: 'Go' },
    ],
    checklistComplete: false,
    attentionItems: [],
    briefingSentence: 'Everything looks healthy.',
    healthRate: 100,
    attentionStockCount: 0,
    outOfStockCount: 0,
    valuePerSku: 0,
    movements7d: 0,
    itemCount: 5,
    lowStockCount: 0,
    openPoCount: 0,
    openCycleCount: 0,
    inventoryValue: 1000,
    inventoryValueSeries: Array(30).fill(100),
    inventoryValueDelta: delta,
    itemCountSeries: Array(30).fill(5),
    itemCountDelta: delta,
    lowOutSeries: Array(30).fill(0),
    lowOutDelta: delta,
    dailyCounts: Array(30).fill(1),
    movementsToday: 1,
    movementsDelta: delta,
    warehouseFilter: null,
    valueSeries: Array.from({ length: 30 }, (_, i) => ({ value: 100 + i, label: `D-${30 - i}` })),
    barValues: Array(30).fill(1),
    breakdownRows: [{ label: 'Receive', share: 0.5, val: 10 }],
    analytics: { valueSeries: {}, byCategory: [], byWarehouse: [], movementBars: [] },
    lowStock: [],
    lowStockTrends: new Map(),
    recentMovements: [],
    ...overrides,
  };
}

/**
 * Render the resolved widget list inside a container that tags each top-level
 * widget with its position, so the test can assert ORDER. We can't rely on the
 * components' own markup for identity (several render bare sections), so we key
 * off the React node `key` we pass — instead we render and read which catalog
 * markers are present, in DOM order, via known text/landmarks per widget.
 */
function renderBody(widgetIds: string[], props = makeProps()) {
  return render(<>{renderDashboardWidgets(widgetIds, props)}</>);
}

describe('renderDashboardWidgets + resolveDashboardWidgets', () => {
  it('renders ALL widgets in the catalog default order for a null layout', () => {
    const ids = resolveDashboardWidgets(null, ALL_IDS);
    // Default = full catalog order, all visible.
    expect(ids).toEqual([
      'get-started',
      'needs-attention',
      'trends-header',
      'shift-command',
      'stat-row',
      'value-chart',
      'movements-breakdown',
      'analytics',
      'recent-activity',
    ]);

    const { container } = renderBody(ids);
    // Spot-check that a marker from EACH widget is present in the DOM.
    expect(container.textContent).toContain('Step A'); // get-started checklist
    expect(container.textContent).toContain('Everything looks healthy.'); // needs-attention
    expect(container.textContent).toContain('30-day trends'); // trends-header
    expect(container.textContent).toContain('Shift command'); // shift-command
    expect(container.textContent).toContain('Inventory value'); // stat-row card label
    expect(container.querySelector('[data-testid="big-chart"]')).not.toBeNull(); // value-chart
    expect(container.textContent).toContain('Movements · 30 days'); // movements-breakdown
    expect(container.querySelector('[data-testid="analytics-island"]')).not.toBeNull(); // analytics
    expect(container.textContent).toContain('Recent activity'); // recent-activity
  });

  it('renders the default catalog order even for a malformed layout (fail-closed)', () => {
    // garbage / wrong-version layouts must fall back to the full default order.
    for (const bad of [undefined, {}, { v: 2 }, { v: 1 }, 'nope', 42] as unknown[]) {
      const ids = resolveDashboardWidgets(bad as DashboardLayout | null, ALL_IDS);
      expect(ids).toEqual(ALL_IDS);
    }
  });

  it('omits a hidden widget but keeps the rest in order', () => {
    const layout: DashboardLayout = {
      v: 1,
      widgets: ALL_IDS.map((id) => ({ id, hidden: id === 'analytics' })),
    };
    const ids = resolveDashboardWidgets(layout, ALL_IDS);
    expect(ids).not.toContain('analytics');
    expect(ids).toEqual(ALL_IDS.filter((id) => id !== 'analytics'));

    const { container } = renderBody(ids);
    expect(container.querySelector('[data-testid="analytics-island"]')).toBeNull();
    // A neighbor still renders.
    expect(container.textContent).toContain('Recent activity');
  });

  it('reorders widgets per the layout', () => {
    const reordered = ['recent-activity', 'stat-row', 'needs-attention'];
    const layout: DashboardLayout = {
      v: 1,
      widgets: reordered.map((id) => ({ id })),
    };
    const ids = resolveDashboardWidgets(layout, ALL_IDS);
    // The three requested come first in the requested order; the remaining
    // available ids are appended in catalog order (so nothing silently drops).
    expect(ids.slice(0, 3)).toEqual(reordered);
    expect(new Set(ids)).toEqual(new Set(ALL_IDS));

    // DOM order: recent-activity markers appear before stat-row markers.
    const { container } = renderBody(ids);
    const html = container.innerHTML;
    expect(html.indexOf('Recent activity')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('Recent activity')).toBeLessThan(html.indexOf('Everything looks healthy.'));
  });

  it('suppresses the get-started widget when the checklist is complete', () => {
    const ids = resolveDashboardWidgets(null, ALL_IDS);
    const { container } = renderBody(ids, makeProps({ checklistComplete: true }));
    // Checklist step text is gone; the rest of the body still renders.
    expect(container.textContent).not.toContain('Step A');
    expect(container.textContent).toContain('30-day trends');
  });

  it('skips unknown ids defensively (id with no bound component)', () => {
    const { container } = renderBody(['stat-row', 'not-a-real-widget', 'recent-activity']);
    expect(container.textContent).toContain('Inventory value');
    expect(container.textContent).toContain('Recent activity');
  });

  it('groups value-chart + movements-breakdown into one shared 12-col grid row by default', () => {
    const ids = resolveDashboardWidgets(null, ALL_IDS);
    const { container } = renderBody(ids);
    // Find the grid that holds BOTH the big-chart (value-chart, col-span-9) and
    // the movements breakdown (col-span-3) — i.e. they share a parent grid row.
    const bigChart = container.querySelector('[data-testid="big-chart"]')!;
    const chartRow = bigChart.closest('.lg\\:grid-cols-12');
    expect(chartRow).not.toBeNull();
    expect(chartRow!.textContent).toContain('Movements · 30 days');
  });
});
