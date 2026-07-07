import { describe, expect, it } from 'vitest';

import {
  mapHistorySeries,
  mapMovementMetrics,
  type DashboardHistory,
  type HistorySeriesRow,
  type MovementMetricRow,
  type ThirtyDayMetrics,
} from './movements';

/**
 * PARITY SUITE for migrations 0224 + 0228 — since migration 0230 this pins the
 * RECONSTRUCTED functions (dashboard_history_series_reconstructed /
 * dashboard_movement_metrics_reconstructed).
 *
 * The dashboard value/low-out/item-count history and the 30-day movement
 * metrics moved from an in-Node reverse-walk / per-row JS count into two
 * set-based Postgres RPCs (dashboard_history_series, dashboard_movement_metrics).
 * This is the MONEY chart — wrong math is worse than slow — so this suite pins
 * the new path to the OLD one:
 *
 *   • `referenceHistory` / `referenceMetrics` are VERBATIM copies of the
 *     pre-0224 movements.ts algorithms (the code that produced "today's correct
 *     output"). They are the source of truth.
 *   • `simulateHistoryRpc` / `simulateMetricsRpc` are INDEPENDENT re-derivations
 *     of what the 0224 SQL RPCs emit (per-day rows), mirroring that migration's
 *     set-based logic line-for-line — NOT copied from the reference.
 *   • `simulateHistoryRpcEventBased` mirrors migration 0228's EVENT-BASED
 *     rewrite of dashboard_history_series (low/out reconstructed from ±1
 *     status-flip events at each mover's own delta days, O(movements) instead
 *     of 0224's movers×days walk). It must equal the reference AND be
 *     row-identical to the 0224 simulation on every fixture — the same
 *     row-by-row diff the ship gate runs against captured prod outputs.
 *   • The production mappers (mapHistorySeries / mapMovementMetrics) then turn
 *     the simulated RPC rows back into the shapes the widgets consume.
 *
 * MIGRATION 0230 (snapshot rollups): the public RPCs now read closed days from
 * precomputed snapshot tables (OBSERVED UTC-day closes) and compute only TODAY
 * live; the 0228/0224 bodies pinned here live on VERBATIM as
 * dashboard_history_series_reconstructed / dashboard_movement_metrics_
 * reconstructed — they are (a) what the nightly refresh derives snapshots
 * from and (b) the RPCs' fallback for warehouse-scoped calls and windows with
 * missing snapshot days. So this suite still guards live prod math; NOTHING
 * here may be weakened. The snapshot read path itself (hit / gap-fallback /
 * warehouse-fallback / today-live) is asserted by
 * supabase/tests/0230_dashboard_snapshot_rollups.test.sql.
 *
 * If the RPC math ever drifts from the reverse-walk, `mapX(simulateX(...))` will
 * stop deep-equalling `referenceX(...)`. The actual SQL is separately hand-
 * verified by supabase/tests/0224_dashboard_history_series.test.sql and
 * supabase/tests/0228_dashboard_history_event_based.test.sql (which run
 * against the reconstructed bodies via the 0230 fallback path).
 *
 * All fixtures use integer quantities/costs so numeric(SQL) and float64(JS)
 * arithmetic are bit-identical — no tolerance needed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface ItemFix {
  id: string;
  quantity_on_hand: number;
  unit_cost: number;
  reorder_point: number;
  created_at: string;
}
interface MovFix {
  item_id: string;
  quantity_change: number;
  created_at: string;
}

// ── Reference: verbatim pre-0224 getDashboardHistory reverse-walk ────────────
// `items` is the scoped (active/non-deleted/warehouse) set. Movements for
// item_ids absent from the scope are skipped (costById undefined) exactly as
// the shipped code did; the `t < startMs` guard models the query's
// `.gte('created_at', startMs)` window filter.
function referenceHistory(
  items: ItemFix[],
  movs: MovFix[],
  rangeDays: number,
  now: number,
): DashboardHistory {
  const startMs = now - rangeDays * DAY_MS;
  const qtyById = new Map<string, number>();
  const costById = new Map<string, number>();
  const reorderById = new Map<string, number>();
  const createdAtTimes: number[] = [];
  let valueToday = 0;
  for (const r of items) {
    const qty = Number(r.quantity_on_hand) || 0;
    const cost = Number(r.unit_cost) || 0;
    const reorder = Number(r.reorder_point) || 0;
    qtyById.set(r.id, qty);
    costById.set(r.id, cost);
    reorderById.set(r.id, reorder);
    createdAtTimes.push(new Date(r.created_at).getTime());
    valueToday += qty * cost;
  }

  const lastIdx = rangeDays - 1;
  const movesByDay: Array<Array<{ item_id: string; quantity_change: number }>> = Array.from(
    { length: rangeDays },
    () => [],
  );
  for (const r of movs) {
    const t = new Date(r.created_at).getTime();
    if (t < startMs) continue; // DB window filter
    const dayIdx = Math.min(lastIdx, Math.max(0, Math.floor((t - startMs) / DAY_MS)));
    movesByDay[dayIdx]!.push({ item_id: r.item_id, quantity_change: Number(r.quantity_change) || 0 });
  }

  const inventoryValueSeries = new Array<number>(rangeDays).fill(0);
  const lowOutSeries = new Array<number>(rangeDays).fill(0);
  let value = valueToday;
  const countLowOut = () => {
    let n = 0;
    for (const [id, qty] of qtyById) {
      const reorder = reorderById.get(id) ?? 0;
      if (reorder > 0 && qty <= reorder) n++;
      else if (qty <= 0) n++;
    }
    return n;
  };
  for (let d = lastIdx; d >= 0; d--) {
    inventoryValueSeries[d] = value;
    lowOutSeries[d] = countLowOut();
    for (const m of movesByDay[d]!) {
      const cost = costById.get(m.item_id);
      if (cost === undefined) continue; // non-scope move skipped
      value -= m.quantity_change * cost;
      const prev = qtyById.get(m.item_id) ?? 0;
      qtyById.set(m.item_id, prev - m.quantity_change);
    }
  }

  const sorted = [...createdAtTimes].sort((a, b) => a - b);
  const itemCountSeries = new Array<number>(rangeDays).fill(0);
  let cursor = 0;
  for (let d = 0; d < rangeDays; d++) {
    const dayEnd = startMs + (d + 1) * DAY_MS;
    while (cursor < sorted.length && sorted[cursor]! <= dayEnd) cursor++;
    itemCountSeries[d] = cursor;
  }

  return { rangeDays, itemCountSeries, inventoryValueSeries, lowOutSeries };
}

// ── Simulated dashboard_history_series RPC (mirror of migration 0224 SQL) ─────
// Independent re-derivation: valueToday − reverse-cumulative per-day value
// delta; per-item qty reconstruction for the low/out count; created_at
// creation-bucket cumulative for item count. Returns one row per day 0..N-1.
function simulateHistoryRpc(
  items: ItemFix[],
  movs: MovFix[],
  rangeDays: number,
  now: number,
): HistorySeriesRow[] {
  const startMs = now - rangeDays * DAY_MS;
  const lastIdx = rangeDays - 1;
  const scope = new Map<string, { qty: number; cost: number; reorder: number; created: number }>();
  for (const it of items) {
    scope.set(it.id, {
      qty: Number(it.quantity_on_hand) || 0,
      cost: Number(it.unit_cost) || 0,
      reorder: Number(it.reorder_point) || 0,
      created: new Date(it.created_at).getTime(),
    });
  }
  const valueToday = [...scope.values()].reduce((s, x) => s + x.qty * x.cost, 0);
  const dayIndexOf = (t: number) => Math.min(lastIdx, Math.max(0, Math.floor((t - startMs) / DAY_MS)));

  // mov: per (item, day) qty delta — scope-joined + in-window. Plus the org-wide
  // per-day value delta for the value walk.
  const perItemDay = new Map<string, number[]>();
  const dayValueDelta = new Array<number>(rangeDays).fill(0);
  for (const m of movs) {
    const t = new Date(m.created_at).getTime();
    if (t < startMs) continue; // window
    const x = scope.get(m.item_id);
    if (!x) continue; // JOIN scope_items
    const day = dayIndexOf(t);
    const delta = Number(m.quantity_change) || 0;
    if (!perItemDay.has(m.item_id)) perItemDay.set(m.item_id, new Array<number>(rangeDays).fill(0));
    const arr = perItemDay.get(m.item_id)!;
    arr[day] = (arr[day] ?? 0) + delta;
    dayValueDelta[day] = (dayValueDelta[day] ?? 0) + delta * x.cost;
  }

  // value[d] = valueToday − Σ_{j>d} dayValueDelta[j]
  const value = new Array<number>(rangeDays).fill(0);
  let suffix = 0;
  for (let d = lastIdx; d >= 0; d--) {
    value[d] = valueToday - suffix;
    suffix += dayValueDelta[d]!;
  }

  // itemCount: creation bucket b = greatest(0, ceil((created−start)/day − 1));
  // buckets > lastIdx (future-dated items) are dropped, exactly like the SQL
  // left join to the day spine and the JS sweep (never counted).
  const bucketCounts = new Array<number>(rangeDays).fill(0);
  for (const x of scope.values()) {
    const b = Math.max(0, Math.ceil((x.created - startMs) / DAY_MS - 1));
    if (b >= 0 && b <= lastIdx) bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
  }
  const itemCount = new Array<number>(rangeDays).fill(0);
  let acc = 0;
  for (let d = 0; d < rangeDays; d++) {
    acc += bucketCounts[d]!;
    itemCount[d] = acc;
  }

  // low/out: nonmover base (constant) + per-day mover reconstruction.
  const movers = new Set(perItemDay.keys());
  let nonmoverBase = 0;
  for (const [id, x] of scope) {
    if (movers.has(id)) continue;
    const thr = x.reorder > 0 ? x.reorder : 0;
    if (x.qty <= thr) nonmoverBase++;
  }
  const lowOut = new Array<number>(rangeDays).fill(0);
  for (let d = 0; d < rangeDays; d++) {
    let moverCount = 0;
    for (const [id, deltas] of perItemDay) {
      const x = scope.get(id)!;
      let after = 0;
      for (let j = d + 1; j < rangeDays; j++) after += deltas[j]!;
      const qtyAtDay = x.qty - after;
      const thr = x.reorder > 0 ? x.reorder : 0;
      if (qtyAtDay <= thr) moverCount++;
    }
    lowOut[d] = moverCount + nonmoverBase;
  }

  const rows: HistorySeriesRow[] = [];
  for (let d = 0; d < rangeDays; d++) {
    rows.push({
      day_index: d,
      item_count: itemCount[d]!,
      inventory_value: value[d]!,
      low_out_count: lowOut[d]!,
    });
  }
  return rows;
}

// ── Simulated dashboard_history_series RPC, EVENT-BASED (migration 0228) ─────
// Independent re-derivation of the 0228 SQL. The value walk and item-count
// sweep are unchanged from 0224; low/out is rebuilt event-based:
//   base   = every scope item's status at (qty − total in-window Δ) — the
//            window-start baseline; nonmovers have Δ = 0 so this is their
//            constant current-qty status. NO created_at filter (0224 parity:
//            mid-window-created items count from day 0 with reconstructed qty).
//   events = per (mover, delta-day), walking the item's OWN delta days newest →
//            oldest with a running suffix sum:
//              qtyAfter  = qty − suffix   (end-of-day qty on that segment)
//              qtyBefore = qtyAfter − Δ(day)   (the previous segment's qty)
//            and a status flip contributes ±1 on that day.
//   lowOut[d] = base + Σ events on days ≤ d (end-of-day: a day-d event counts
//               on day d itself), cumulated over the day spine.
function simulateHistoryRpcEventBased(
  items: ItemFix[],
  movs: MovFix[],
  rangeDays: number,
  now: number,
): HistorySeriesRow[] {
  const startMs = now - rangeDays * DAY_MS;
  const lastIdx = rangeDays - 1;
  const scope = new Map<string, { qty: number; cost: number; reorder: number; created: number }>();
  for (const it of items) {
    scope.set(it.id, {
      qty: Number(it.quantity_on_hand) || 0,
      cost: Number(it.unit_cost) || 0,
      reorder: Number(it.reorder_point) || 0,
      created: new Date(it.created_at).getTime(),
    });
  }
  const valueToday = [...scope.values()].reduce((s, x) => s + x.qty * x.cost, 0);
  const dayIndexOf = (t: number) => Math.min(lastIdx, Math.max(0, Math.floor((t - startMs) / DAY_MS)));

  // mov: per (item, day) net qty delta — SPARSE (only the item's delta days),
  // mirroring the SQL's group-by; plus the per-day value delta.
  const perItemDeltaDays = new Map<string, Map<number, number>>();
  const dayValueDelta = new Array<number>(rangeDays).fill(0);
  for (const m of movs) {
    const t = new Date(m.created_at).getTime();
    if (t < startMs) continue; // window
    const x = scope.get(m.item_id);
    if (!x) continue; // JOIN scope_items
    const day = dayIndexOf(t);
    const delta = Number(m.quantity_change) || 0;
    let byDay = perItemDeltaDays.get(m.item_id);
    if (!byDay) perItemDeltaDays.set(m.item_id, (byDay = new Map()));
    byDay.set(day, (byDay.get(day) ?? 0) + delta);
    dayValueDelta[day] = (dayValueDelta[day] ?? 0) + delta * x.cost;
  }

  // value[d] = valueToday − Σ_{j>d} dayValueDelta[j]  (unchanged from 0224)
  const value = new Array<number>(rangeDays).fill(0);
  let suffix = 0;
  for (let d = lastIdx; d >= 0; d--) {
    value[d] = valueToday - suffix;
    suffix += dayValueDelta[d]!;
  }

  // itemCount: creation-bucket cumulative (unchanged from 0224).
  const bucketCounts = new Array<number>(rangeDays).fill(0);
  for (const x of scope.values()) {
    const b = Math.max(0, Math.ceil((x.created - startMs) / DAY_MS - 1));
    if (b >= 0 && b <= lastIdx) bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
  }
  const itemCount = new Array<number>(rangeDays).fill(0);
  let acc = 0;
  for (let d = 0; d < rangeDays; d++) {
    acc += bucketCounts[d]!;
    itemCount[d] = acc;
  }

  // low/out: window-start baseline + ±1 status-flip events.
  const thresholdOf = (x: { reorder: number }) => (x.reorder > 0 ? x.reorder : 0);
  const eventsByDay = new Array<number>(rangeDays).fill(0);
  let base = 0;
  for (const [id, x] of scope) {
    const byDay = perItemDeltaDays.get(id);
    let totalDelta = 0;
    if (byDay) for (const d of byDay.values()) totalDelta += d;
    if (x.qty - totalDelta <= thresholdOf(x)) base++;
    if (!byDay) continue; // nonmover: constant status, no events
    const deltaDays = [...byDay.keys()].sort((a, b) => b - a); // newest → oldest
    let suffixAfter = 0; // Σ Δ on the item's LATER delta days
    for (const d of deltaDays) {
      const delta = byDay.get(d)!;
      const qtyAfter = x.qty - suffixAfter;
      const qtyBefore = qtyAfter - delta; // zero-net day → identical → no event
      const thr = thresholdOf(x);
      const change = (qtyAfter <= thr ? 1 : 0) - (qtyBefore <= thr ? 1 : 0);
      if (change !== 0) eventsByDay[d] = (eventsByDay[d] ?? 0) + change;
      suffixAfter += delta;
    }
  }
  const lowOut = new Array<number>(rangeDays).fill(0);
  let cumulative = base;
  for (let d = 0; d < rangeDays; d++) {
    cumulative += eventsByDay[d]!;
    lowOut[d] = cumulative;
  }

  const rows: HistorySeriesRow[] = [];
  for (let d = 0; d < rangeDays; d++) {
    rows.push({
      day_index: d,
      item_count: itemCount[d]!,
      inventory_value: value[d]!,
      low_out_count: lowOut[d]!,
    });
  }
  return rows;
}

// ── Reference: verbatim pre-0224 getThirtyDayMetrics (post-DB-filter) ─────────
function referenceMetrics(
  scope: Set<string>,
  movs: Array<MovFix & { movement_type: string }>,
  now: number,
): ThirtyDayMetrics {
  const since = now - 30 * DAY_MS;
  const dailyCounts = new Array<number>(30).fill(0);
  const byTypeMap = new Map<string, number>();
  for (const r of movs) {
    const t = new Date(r.created_at).getTime();
    if (t < since) continue; // window filter (.gte created_at since)
    if (!scope.has(r.item_id)) continue; // inner-join scope
    const dayIdx = Math.min(29, Math.max(0, Math.floor((t - since) / DAY_MS)));
    dailyCounts[dayIdx] = (dailyCounts[dayIdx] ?? 0) + 1;
    byTypeMap.set(r.movement_type, (byTypeMap.get(r.movement_type) ?? 0) + 1);
  }
  const byTypeRaw = [...byTypeMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const max = byTypeRaw[0]?.count ?? 1;
  const byType = byTypeRaw.map((r) => ({ ...r, share: r.count / max }));
  return { dailyCounts, byType };
}

// ── Simulated dashboard_movement_metrics RPC (mirror of migration 0224 SQL) ───
function simulateMetricsRpc(
  scope: Set<string>,
  movs: Array<MovFix & { movement_type: string }>,
  now: number,
): MovementMetricRow[] {
  const since = now - 30 * DAY_MS;
  const grouped = new Map<string, { day: number; type: string; count: number }>();
  for (const r of movs) {
    const t = new Date(r.created_at).getTime();
    if (t < since) continue;
    if (!scope.has(r.item_id)) continue;
    const day = Math.min(29, Math.max(0, Math.floor((t - since) / DAY_MS)));
    const key = `${day} ${r.movement_type}`;
    const cur = grouped.get(key);
    if (cur) cur.count += 1;
    else grouped.set(key, { day, type: r.movement_type, count: 1 });
  }
  return [...grouped.values()].map((g) => ({
    day_index: g.day,
    movement_type: g.type,
    move_count: g.count,
  }));
}

// Anchor `now` at a fixed instant so day math is deterministic across runs.
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0);
const daysAgo = (n: number, hourOffset = 0) =>
  new Date(NOW - n * DAY_MS + hourOffset * 60 * 60 * 1000).toISOString();

// Event-path stress fixtures (also seeded, hand-computed, in the 0228 pgTAP
// test): U flips low→ok→low; V's reconstructed qty equals its threshold
// EXACTLY on the flip's boundary day; W is created MID-WINDOW with its stock
// arriving via a movement (per 0224/0228 semantics low_out ignores created_at,
// so W counts as OUT on days before creation while item_count picks it up at
// its creation bucket); X is a nonmover already low; Y has a ZERO-NET delta
// day (+5/−5) plus a real delta day.
const stressItems: ItemFix[] = [
  { id: 'U', quantity_on_hand: 3, unit_cost: 2, reorder_point: 5, created_at: daysAgo(100) },
  { id: 'V', quantity_on_hand: 10, unit_cost: 1, reorder_point: 4, created_at: daysAgo(100) },
  { id: 'W', quantity_on_hand: 20, unit_cost: 3, reorder_point: 0, created_at: daysAgo(2, 18) },
  { id: 'X', quantity_on_hand: 2, unit_cost: 4, reorder_point: 3, created_at: daysAgo(100) },
  { id: 'Y', quantity_on_hand: 8, unit_cost: 5, reorder_point: 0, created_at: daysAgo(100) },
];
const stressMovs: MovFix[] = [
  { item_id: 'U', quantity_change: 10, created_at: daysAgo(3, 12) }, // low→ok
  { item_id: 'U', quantity_change: -10, created_at: daysAgo(1, 12) }, // ok→low
  { item_id: 'U', quantity_change: 777, created_at: daysAgo(9) }, // out-of-window (4d AND 6d)
  { item_id: 'V', quantity_change: 6, created_at: daysAgo(2, 12) }, // qtyBefore = 4 = threshold exactly
  { item_id: 'W', quantity_change: 20, created_at: daysAgo(2, 20) }, // W OUT (qty 0) pre-creation
  { item_id: 'Y', quantity_change: 5, created_at: daysAgo(3, 8) }, // zero-net day …
  { item_id: 'Y', quantity_change: -5, created_at: daysAgo(3, 9) }, // … must be a no-op
  { item_id: 'Y', quantity_change: 9, created_at: daysAgo(2, 8) }, // out→ok
];

// Shared across the 0224 and 0228 parity loops below.
const historyCases: Array<{ name: string; rangeDays: number; items: ItemFix[]; movs: MovFix[] }> = [
    {
      name: 'movers + nonmovers, threshold flips, mixed creation dates, 5-day window',
      rangeDays: 5,
      items: [
        // Mover whose historical qty was higher → low-flip across days.
        { id: 'A', quantity_on_hand: 2, unit_cost: 10, reorder_point: 5, created_at: daysAgo(100) },
        // Nonmover, always out (qty 0, reorder 0 → threshold 0).
        { id: 'B', quantity_on_hand: 0, unit_cost: 5, reorder_point: 0, created_at: daysAgo(90) },
        // Nonmover, healthy, created INSIDE the window (day ~2).
        { id: 'C', quantity_on_hand: 100, unit_cost: 1, reorder_point: 10, created_at: daysAgo(2, 6) },
        // Mover with two movements on different days.
        { id: 'D', quantity_on_hand: 50, unit_cost: 2, reorder_point: 0, created_at: daysAgo(120) },
      ],
      movs: [
        { item_id: 'A', quantity_change: 8, created_at: daysAgo(1, 3) }, // day ~3
        { item_id: 'A', quantity_change: -1, created_at: daysAgo(1, 4) }, // same day ~3, aggregates
        { item_id: 'D', quantity_change: -20, created_at: daysAgo(3, 12) }, // day ~1
        { item_id: 'D', quantity_change: 5, created_at: daysAgo(0, 6) }, // day ~4
        // Non-scope movement (item not in the item list): must be ignored.
        { item_id: 'ZZZ', quantity_change: 999, created_at: daysAgo(2) },
        // Out-of-window movement (older than the 5-day window): must be ignored.
        { item_id: 'A', quantity_change: 777, created_at: daysAgo(40) },
      ],
    },
    {
      name: 'boundary + future-dated movement clamp, negative reorder, 5-day window',
      rangeDays: 5,
      items: [
        { id: 'E', quantity_on_hand: 4, unit_cost: 3, reorder_point: -2, created_at: daysAgo(10) },
        { id: 'F', quantity_on_hand: 7, unit_cost: 8, reorder_point: 7, created_at: daysAgo(4, 23) },
      ],
      movs: [
        // Exact window boundary (created_at == startMs): included, day 0.
        { item_id: 'E', quantity_change: 3, created_at: daysAgo(5) },
        // Future-dated (clock skew): clamps into the last day index.
        { item_id: 'F', quantity_change: -2, created_at: daysAgo(0, 5) },
      ],
    },
    {
      name: 'no movements at all — flat series, 30-day window',
      rangeDays: 30,
      items: [
        { id: 'G', quantity_on_hand: 0, unit_cost: 4, reorder_point: 3, created_at: daysAgo(200) },
        { id: 'H', quantity_on_hand: 12, unit_cost: 6, reorder_point: 4, created_at: daysAgo(15) },
      ],
      movs: [],
    },
    {
      name: 'empty org — all zeros, 30-day window',
      rangeDays: 30,
      items: [],
      movs: [],
    },
    {
      name: 'dense movements over a 30-day window',
      rangeDays: 30,
      items: [
        { id: 'I', quantity_on_hand: 30, unit_cost: 7, reorder_point: 20, created_at: daysAgo(365) },
        { id: 'J', quantity_on_hand: 5, unit_cost: 2, reorder_point: 5, created_at: daysAgo(45) },
        { id: 'K', quantity_on_hand: 0, unit_cost: 9, reorder_point: 0, created_at: daysAgo(10) },
      ],
      movs: [
        { item_id: 'I', quantity_change: -5, created_at: daysAgo(25) },
        { item_id: 'I', quantity_change: 15, created_at: daysAgo(12) },
        { item_id: 'I', quantity_change: -10, created_at: daysAgo(3) },
        { item_id: 'J', quantity_change: 2, created_at: daysAgo(20) },
        { item_id: 'J', quantity_change: -4, created_at: daysAgo(20, 2) },
        { item_id: 'K', quantity_change: 8, created_at: daysAgo(6) },
        { item_id: 'K', quantity_change: -8, created_at: daysAgo(1) },
      ],
    },
    {
      name: 'event-path stress: low→ok→low flip, exact-threshold boundary, mid-window creation counted out pre-creation, nonmover low, zero-net delta day (4-day window)',
      rangeDays: 4,
      items: stressItems,
      movs: stressMovs,
    },
    {
      name: 'event-path stress over a longer window — event-free gap days carry the baseline (6-day window)',
      rangeDays: 6,
      items: stressItems,
      movs: stressMovs,
    },
  ];

describe('dashboard_history_series parity (RPC vs pre-0224 reverse-walk)', () => {
  for (const c of historyCases) {
    it(c.name, () => {
      const reference = referenceHistory(c.items, c.movs, c.rangeDays, NOW);
      const viaRpc = mapHistorySeries(simulateHistoryRpc(c.items, c.movs, c.rangeDays, NOW), c.rangeDays);
      expect(viaRpc).toEqual(reference);
    });
  }

  it('last index reconciles with the summary contract (value/itemCount/lowOut today)', () => {
    const items: ItemFix[] = [
      { id: 'A', quantity_on_hand: 2, unit_cost: 10, reorder_point: 5, created_at: daysAgo(100) },
      { id: 'B', quantity_on_hand: 0, unit_cost: 5, reorder_point: 0, created_at: daysAgo(90) },
      { id: 'C', quantity_on_hand: 100, unit_cost: 1, reorder_point: 10, created_at: daysAgo(1) },
    ];
    const movs: MovFix[] = [{ item_id: 'A', quantity_change: 8, created_at: daysAgo(1, 3) }];
    const h = mapHistorySeries(simulateHistoryRpc(items, movs, 5, NOW), 5);
    const last = 4;
    // valueToday = 2*10 + 0*5 + 100*1 = 120
    expect(h.inventoryValueSeries[last]).toBe(120);
    // all three items exist today
    expect(h.itemCountSeries[last]).toBe(3);
    // A: 2<=5 low; B: 0<=0 out; C: 100>10 healthy → 2
    expect(h.lowOutSeries[last]).toBe(2);
  });
});

describe('dashboard_history_series parity — EVENT-BASED rewrite (migration 0228)', () => {
  // The 0228 SQL replaces 0224's movers×days low/out walk with status-flip
  // events (O(movements)). Output must be IDENTICAL: every fixture is asserted
  // both against the pre-0224 reference reverse-walk AND row-for-row against
  // the 0224 simulation — the same row-by-row diff the ship gate runs.
  for (const c of historyCases) {
    it(`${c.name} — event algorithm equals the reference reverse-walk`, () => {
      const reference = referenceHistory(c.items, c.movs, c.rangeDays, NOW);
      const viaRpc = mapHistorySeries(
        simulateHistoryRpcEventBased(c.items, c.movs, c.rangeDays, NOW),
        c.rangeDays,
      );
      expect(viaRpc).toEqual(reference);
    });

    it(`${c.name} — event algorithm is row-identical to the 0224 movers×days simulation`, () => {
      expect(simulateHistoryRpcEventBased(c.items, c.movs, c.rangeDays, NOW)).toEqual(
        simulateHistoryRpc(c.items, c.movs, c.rangeDays, NOW),
      );
    });
  }

  it('event-path stress (4d): hand-computed series matches the 0228 pgTAP fixture', () => {
    // Same org/window as supabase/tests/0228_dashboard_history_event_based.
    // test.sql behavioral B — pins the expectations in BOTH suites to one
    // hand-computed truth: value [13,33,144,124], items [4,4,5,5],
    // lowOut [5,4,1,2].
    const h = mapHistorySeries(simulateHistoryRpcEventBased(stressItems, stressMovs, 4, NOW), 4);
    expect(h.inventoryValueSeries).toEqual([13, 33, 144, 124]);
    expect(h.itemCountSeries).toEqual([4, 4, 5, 5]);
    expect(h.lowOutSeries).toEqual([5, 4, 1, 2]);
  });
});

describe('dashboard_movement_metrics parity (RPC rollup vs pre-0224 JS count)', () => {
  const scope = new Set(['A', 'B', 'C']);
  // Distinct per-type totals so byType ordering is unambiguous (no tie-order
  // dependence on Map insertion order).
  const movs: Array<MovFix & { movement_type: string }> = [
    { item_id: 'A', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(2) },
    { item_id: 'B', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(2, 1) },
    { item_id: 'A', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(10) },
    { item_id: 'C', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(29) },
    { item_id: 'A', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(0, 5) }, // future clamp → 29
    { item_id: 'B', movement_type: 'transfer', quantity_change: 1, created_at: daysAgo(5) },
    { item_id: 'C', movement_type: 'transfer', quantity_change: 1, created_at: daysAgo(5, 2) },
    { item_id: 'A', movement_type: 'transfer', quantity_change: 1, created_at: daysAgo(15) },
    { item_id: 'B', movement_type: 'receive_po', quantity_change: 1, created_at: daysAgo(1) },
    // Non-scope (item D not in scope): ignored.
    { item_id: 'D', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(3) },
    // Out-of-window (older than 30d): ignored.
    { item_id: 'A', movement_type: 'adjust', quantity_change: 1, created_at: daysAgo(40) },
  ];

  it('rolls up to the same dailyCounts + byType as the per-row JS path', () => {
    const reference = referenceMetrics(scope, movs, NOW);
    const viaRpc = mapMovementMetrics(simulateMetricsRpc(scope, movs, NOW));
    expect(viaRpc).toEqual(reference);
  });

  it('produces the expected byType totals (adjust 5, transfer 3, receive_po 1)', () => {
    const m = mapMovementMetrics(simulateMetricsRpc(scope, movs, NOW));
    expect(m.byType).toEqual([
      { type: 'adjust', count: 5, share: 1 },
      { type: 'transfer', count: 3, share: 3 / 5 },
      { type: 'receive_po', count: 1, share: 1 / 5 },
    ]);
    expect(m.dailyCounts.reduce((s, n) => s + n, 0)).toBe(9);
  });
});
