// Pure data-mapping helpers: server service shapes -> Recharts-ready series.
//
// Kept framework-free (no React, no 'use client') so they can be unit-tested
// in isolation and reused by both the server (to pre-shape props) and the
// client widgets. Each widget owns its own mapper here; the widget component
// just renders the result.

import type { DashboardHistory, ThirtyDayMetrics } from '@/server/services/movements';
import type { ValuationReport } from '@/server/services/reports';

// ── Inventory value over time ─────────────────────────────────────────────

export interface ValuePoint {
  /** Day index label, e.g. "D-30" … "D-1" / "Today". Stable, locale-free. */
  day: string;
  /** Inventory value (USD, cost basis) at end of that day. */
  value: number;
}

/**
 * Maps a DashboardHistory.inventoryValueSeries (oldest → newest) into labelled
 * points for the value-over-time line/area widget. The final point is labelled
 * "Today"; the rest are "D-N" counting back from today.
 */
export function toValueSeries(history: Pick<DashboardHistory, 'inventoryValueSeries'>): ValuePoint[] {
  const series = history.inventoryValueSeries;
  const n = series.length;
  return series.map((value, i) => {
    const fromEnd = n - 1 - i; // 0 == today
    return {
      day: fromEnd === 0 ? 'Today' : `D-${fromEnd}`,
      value: Number.isFinite(value) ? value : 0,
    };
  });
}

// ── Inventory value breakdown (category / warehouse) ──────────────────────

export interface BreakdownSlice {
  /** Stable key (id when present, else a sentinel). Used as the Cell key. */
  key: string;
  /** Human-readable label for the legend/tooltip. */
  name: string;
  /** Dollar value of this slice. */
  value: number;
}

export type BreakdownDimension = 'category' | 'warehouse';

/**
 * Maps a ValuationReport into pie/donut slices for the requested dimension.
 * Drops zero/negative-value slices (a $0 category contributes no arc and
 * just clutters the legend). Order is preserved from the report, which is
 * already sorted by value descending.
 */
export function toBreakdownSlices(
  report: Pick<ValuationReport, 'byCategory' | 'byWarehouse'>,
  dimension: BreakdownDimension,
): BreakdownSlice[] {
  if (dimension === 'warehouse') {
    return report.byWarehouse
      .filter((w) => w.value > 0)
      .map((w) => ({
        key: w.warehouseId ?? '__none',
        name: w.warehouseName,
        value: w.value,
      }));
  }
  return report.byCategory
    .filter((c) => c.value > 0)
    .map((c) => ({
      key: c.categoryId ?? '__none',
      name: c.categoryName,
      value: c.value,
    }));
}

// ── Movement volume by type ───────────────────────────────────────────────

export interface MovementBar {
  /** Title-cased, space-separated movement type, e.g. "Receive Po". */
  label: string;
  /** Raw movement type key (snake_case) — stable for config lookups. */
  type: string;
  /** Count of movements of this type in the window. */
  count: number;
}

/**
 * Maps ThirtyDayMetrics.byType into bars for the movement-volume widget.
 * `byType` is already sorted by count descending; we keep that order and
 * title-case the label for display.
 */
export function toMovementBars(metrics: Pick<ThirtyDayMetrics, 'byType'>): MovementBar[] {
  return metrics.byType.map((b) => ({
    type: b.type,
    label: b.type
      .split('_')
      .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' '),
    count: b.count,
  }));
}
