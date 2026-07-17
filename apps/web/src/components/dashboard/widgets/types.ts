import type { AnalyticsGridProps } from '@/components/dashboard/charts/analytics-grid';

import type { AttentionItem } from './shared';

/**
 * The single, already-computed props bag the dashboard page hands to every
 * widget. DashboardBody runs the parallel data fan-out once, derives every
 * value here, then renders the resolved widget id list — each widget reads the
 * slice of this bag it needs. NO widget fetches data; this keeps the load-perf
 * fan-out intact and makes the widgets pure/presentational + unit-testable.
 */

/** A get-started checklist step (mirrors GetStartedChecklist's step shape). */
export interface ChecklistStep {
  id: string;
  done: boolean;
  title: string;
  description: string;
  href: string;
  cta: string;
}

/** A single low-stock table row + its precomputed 14-day qty sparkline. */
export interface LowStockRow {
  id: string;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_point: number;
}

/** A recent stock-movement feed entry (already shaped by MovementsService). */
export interface RecentMovement {
  id: string;
  movement_type: string;
  quantity_change: number | string;
  /** Physical qty moved by a net-zero transfer (mig 0231); null on pre-0231
      rows and non-transfer movements. */
  moved_quantity: number | string | null;
  created_at: string;
  reason: string | null;
  item: { name?: string | null } | null;
  actor: { fullName?: string | null; email?: string | null } | null;
  user_id: string | null;
}

/** Delta token + arrow direction for a StatCard / status readout. */
export interface DeltaToken {
  label: string;
  direction: 'up' | 'down' | 'flat';
}

/** One row of the 30-day movement-type breakdown. */
export interface BreakdownRow {
  label: string;
  share: number;
  val: number;
}

export interface DashboardWidgetProps {
  // get-started
  checklistSteps: ChecklistStep[];
  checklistComplete: boolean;

  // needs-attention
  attentionItems: AttentionItem[];
  briefingSentence: string;

  // trends-header
  healthRate: number;
  attentionStockCount: number;
  outOfStockCount: number;
  valuePerSku: number;
  movements7d: number;

  // shift-command
  itemCount: number;
  lowStockCount: number;
  openPoCount: number;
  openCycleCount: number;

  // stat-row
  inventoryValue: number;
  inventoryValueSeries: number[];
  inventoryValueDelta: DeltaToken;
  itemCountSeries: number[];
  itemCountDelta: DeltaToken;
  lowOutSeries: number[];
  lowOutDelta: DeltaToken;
  dailyCounts: number[];
  movementsToday: number;
  movementsDelta: DeltaToken;
  warehouseFilter: string | null;

  // value-chart
  valueSeries: Array<{ value: number; label: string }>;
  /**
   * Org warehouses for the value card's interactive location filter. Sourced
   * from the page's ALREADY-FETCHED, request-cached warehouse list (getWarehouses
   * ForRequest) — passing it here adds ZERO round-trips to the dashboard load.
   */
  warehouses: Array<{ id: string; name: string }>;

  // movements-breakdown
  barValues: number[];
  breakdownRows: BreakdownRow[];

  // analytics (lazy Recharts island)
  analytics: AnalyticsGridProps;

  // recent-activity
  lowStock: LowStockRow[];
  lowStockTrends: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  recentMovements: RecentMovement[];
}
