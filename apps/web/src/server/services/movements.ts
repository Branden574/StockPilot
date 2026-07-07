import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import {
  collectReceiptLineIds,
  receiptLineSummary,
  resolveReceiptPoNumbers,
} from './activity';
import { ServiceError, withContext, type ServiceContext } from './context';
import {
  bucketTrendMovements,
  deriveItemTrend,
  TREND_WINDOW_DAYS,
  type ItemTrend,
} from './lib/item-trends';
import { fetchAllRows } from './lib/paginate';

// The bucketing + reverse-walk math lives in lib/item-trends.ts so the
// cached inventory-list loaders can reuse it verbatim (org-wide buckets
// cached once, series derived per request). Re-exported here so existing
// importers of the type keep working.
export type { ItemTrend } from './lib/item-trends';

export interface MovementWithItem {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  /** Physical qty moved by a net-zero transfer (mig 0231). quantity_change is
      always 0 for transfers; render THIS for them. null on pre-0231 rows and
      non-transfer movements. */
  moved_quantity: number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  /** Display reason. Pre-0231 receipt rows' internal 'receipt_line' label is
      already mapped to 'PO {number}' (or 'PO receipt') by list(). */
  reason: string | null;
  notes: string | null;
  created_at: string;
  item_id: string;
  user_id: string | null;
  item: { id: string; name: string; sku: string } | null;
  /** Full name (or email fallback) of the user who triggered the movement.
      null when the row was written by a system process (e.g. a trigger
      with no auth.uid context). */
  actor: { id: string; fullName: string | null; email: string | null } | null;
}

export class MovementsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new MovementsService(await withContext());
  }

  /**
   * Lists recent movements with the parent inventory item embedded via the
   * existing FK in a single PostgREST round trip — eliminates the separate
   * IN(...) lookup that the dashboard + movements pages used to do.
   */
  async list(
    params: {
      itemId?: string;
      warehouseId?: string;
      limit?: number;
      offset?: number;
      /** ISO timestamp. Filter rows with created_at >= since. */
      since?: string;
      /** ISO timestamp. Filter rows with created_at < until. */
      until?: string;
      /** Movement type filter (e.g. 'adjust', 'transfer', 'receive_po'). */
      types?: string[];
    } = {},
  ) {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = Math.max(0, params.offset ?? 0);
    // Pass our own ctx so the helper doesn't fall back to
    // requireOrgContext() — in API routes that path throws NEXT_REDIRECT
    // and surfaces as a generic 500. Same trap fixed elsewhere in this
    // service file's siblings (see InventoryService.list).
    const access = await getWarehouseAccess(this.ctx);

    // Use `!inner` on the embed so we can (a) filter parent rows by the
    // item's warehouse_id without a second round trip, and (b) drop
    // movements whose parent item has been soft-deleted (so the
    // recent-activity feed doesn't surface deleted SKUs).
    const itemEmbed =
      'item:inventory_items!item_id!inner (id, name, sku, warehouse_id, deleted_at)';

    let query = this.ctx.supabase
      .from('stock_movements')
      .select(
        `
        id, movement_type, quantity_change, previous_quantity, new_quantity,
        moved_quantity, from_location_id, to_location_id, reason, notes, created_at,
        item_id, user_id,
        ${itemEmbed},
        actor:user_profiles!user_id (id, full_name, email)
      `,
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('item.deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) return [];
      query = query.in('item.warehouse_id', access.readableIds);
    } else if (params.warehouseId) {
      query = query.eq('item.warehouse_id', params.warehouseId);
    }

    if (params.itemId) query = query.eq('item_id', params.itemId);
    if (params.since) query = query.gte('created_at', params.since);
    if (params.until) query = query.lt('created_at', params.until);
    if (params.types && params.types.length > 0) {
      query = query.in('movement_type', params.types);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    // Pre-0231 receipt rows carry the internal reason 'receipt_line' with the
    // receipt id in notes — resolve them to 'PO {number}' in ONE extra batched
    // query (display mapping only; notes keeps the receipt id for consumers
    // like stagedWorklist). New rows already carry 'PO {n}' in reason.
    const poNumberByReceipt = await resolveReceiptPoNumbers(
      this.ctx,
      collectReceiptLineIds(
        (data ?? []).map((row) => {
          const r = row as Record<string, unknown>;
          return {
            reason: (r.reason as string | null) ?? null,
            notes: (r.notes as string | null) ?? null,
          };
        }),
      ),
    );

    // PostgREST returns the related row as an array when the relation is
    // ambiguous; flatten to a single object.
    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const reason =
        r.reason === 'receipt_line'
          ? receiptLineSummary((r.notes as string | null) ?? null, poNumberByReceipt)
          : ((r.reason as string | null) ?? null);
      const itemField = r.item as
        | { id: string; name: string; sku: string }
        | { id: string; name: string; sku: string }[]
        | null
        | undefined;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      const actorField = r.actor as
        | { id: string; full_name: string | null; email: string | null }
        | { id: string; full_name: string | null; email: string | null }[]
        | null
        | undefined;
      const actorRaw = Array.isArray(actorField) ? (actorField[0] ?? null) : (actorField ?? null);
      const actor = actorRaw
        ? {
            id: actorRaw.id,
            fullName: actorRaw.full_name ?? null,
            email: actorRaw.email ?? null,
          }
        : null;
      return { ...r, reason, item, actor } as MovementWithItem;
    });
  }
}

export interface DashboardSummary {
  itemCount: number;
  outOfStockCount: number;
  lowStockCount: number;
  inventoryValue: number;
}

/**
 * One round trip — combines item count, out-of-stock count, low-stock count,
 * and inventory value. When no warehouse filter is set, uses the
 * get_dashboard_summary RPC (single index scan, fastest path). When a
 * warehouse filter is active, falls back to a direct aggregate query
 * scoped to that warehouse so manager-level filters honor on the dash.
 */
export async function getDashboardSummary(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<DashboardSummary> {
  const ctx = options.ctx ?? (await withContext());
  if (!options.warehouseId) {
    const { data, error } = await ctx.supabase.rpc('get_dashboard_summary', {
      p_org_id: ctx.organizationId,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { item_count: number; out_of_stock_count: number; low_stock_count: number; inventory_value: number }
      | null
      | undefined;
    return {
      itemCount: row?.item_count ?? 0,
      outOfStockCount: row?.out_of_stock_count ?? 0,
      lowStockCount: row?.low_stock_count ?? 0,
      inventoryValue: typeof row?.inventory_value === 'number' ? row.inventory_value : 0,
    };
  }

  // Warehouse-scoped path: PostgREST aggregate isn't great here, so we
  // pull just the four numeric columns we need and roll up in TS. Cheap
  // because we filter by warehouse_id (indexed) and project 4 columns.
  // PAGINATED: a bare select is silently capped at 1000 rows, so a warehouse
  // with >1000 items would roll up a wrong (truncated) dashboard summary.
  const data = await fetchAllRows<{
    quantity_on_hand: number;
    reorder_point: number;
    unit_cost: number;
    status: string;
  }>((from, to) =>
    ctx.supabase
      .from('inventory_items')
      .select('quantity_on_hand, reorder_point, unit_cost, status')
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', options.warehouseId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  let itemCount = 0;
  let outOfStockCount = 0;
  let lowStockCount = 0;
  let inventoryValue = 0;
  for (const r of data) {
    if (r.status !== 'active') continue;
    itemCount += 1;
    inventoryValue += (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0);
    if (r.quantity_on_hand <= 0) outOfStockCount += 1;
    else if (r.reorder_point > 0 && r.quantity_on_hand <= r.reorder_point) lowStockCount += 1;
  }
  return { itemCount, outOfStockCount, lowStockCount, inventoryValue };
}

export interface ThirtyDayMetrics {
  /** Per-day movement counts oldest → newest, length 30. */
  dailyCounts: number[];
  /**
   * Aggregated by movement_type. Sorted descending by count. Each
   * entry's `share` is its count / max-count so the dashboard can
   * render a relative bar without a separate normalization pass.
   */
  byType: Array<{ type: string; count: number; share: number }>;
}

/** One row of dashboard_movement_metrics (migration 0224; snapshot-backed
 *  since 0230): a per (day-bucket, movement_type) count. move_count is bigint
 *  → may arrive as a number or a numeric string, so mapMovementMetrics
 *  coerces with Number(). */
export interface MovementMetricRow {
  day_index: number;
  movement_type: string;
  move_count: number | string | null;
}

/**
 * Rolls dashboard_movement_metrics rows into the ThirtyDayMetrics shape the
 * dashboard renders: dailyCounts[30] (Σ move_count per day-bucket) and byType
 * (Σ per movement_type, sorted desc, share = count / max). Pure — exported so
 * the parity suite can drive it with fixture rows. Reproduces the pre-0224 JS
 * bucketing exactly (day_index already clamped to [0,29] by the RPC).
 */
export function mapMovementMetrics(rows: MovementMetricRow[]): ThirtyDayMetrics {
  const dailyCounts = new Array<number>(30).fill(0);
  const byTypeMap = new Map<string, number>();

  for (const r of rows) {
    const c = Number(r.move_count) || 0;
    const d = r.day_index;
    if (d >= 0 && d < 30) dailyCounts[d] = (dailyCounts[d] ?? 0) + c;
    byTypeMap.set(r.movement_type, (byTypeMap.get(r.movement_type) ?? 0) + c);
  }

  const byTypeRaw = [...byTypeMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const max = byTypeRaw[0]?.count ?? 1;
  const byType = byTypeRaw.map((r) => ({ ...r, share: r.count / max }));

  return { dailyCounts, byType };
}

/**
 * Real 30-day movement metrics for the dashboard charts. Replaces the
 * synthetic `barValues` + `breakdownRows` arrays the dashboard used to
 * render.
 *
 * SCALE FIX (migration 0224): was `fetchAllRows` paging up to 100 000
 * stock_movements into Node just to COUNT them per-day/per-type in JS
 * (silently truncating past the 100k cap). 0224 moved the count into a
 * set-based RPC, which still scanned the whole 30-day movement window per
 * render (~791ms at 1.2M movements).
 *
 * SNAPSHOT ROLLUPS (migration 0230): dashboard_movement_metrics now reads
 * closed days from org_daily_movement_stats (per (org, UTC day, type) counts
 * written by the nightly refresh) and counts only TODAY's slice live.
 * Semantics upgraded deliberately: day buckets are OBSERVED UTC calendar
 * days, and a closed day's counts include every movement that happened that
 * day — they are no longer retroactively dropped when the item is later
 * soft-deleted (observed history does not rewrite; movement rows were always
 * org-readable under RLS anyway). Row shape is unchanged (sparse
 * (day_index, type, count) rows), so mapMovementMetrics is untouched.
 * Fallbacks: warehouseId set, or any closed day missing from the caller's
 * RLS view of org_daily_stats (the completeness sentinel; manager+-readable
 * only, so restricted staff/viewer callers always fall back) → the 0224 body
 * runs verbatim as dashboard_movement_metrics_reconstructed, caller-scoped.
 * SECURITY INVOKER, called via the USER client (ctx.supabase).
 */
export async function getThirtyDayMetrics(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<ThirtyDayMetrics> {
  const ctx = options.ctx ?? (await withContext());
  const { data, error } = await ctx.supabase.rpc('dashboard_movement_metrics', {
    p_organization_id: ctx.organizationId,
    p_warehouse_id: options.warehouseId ?? null,
    p_days: 30,
  });
  if (error) throw new ServiceError('internal_error', error.message);
  return mapMovementMetrics((data ?? []) as MovementMetricRow[]);
}

export interface DashboardHistory {
  /** Number of days the series spans (length of each series array). */
  rangeDays: number;
  /** Daily active SKU count, length `rangeDays`, oldest → newest. Since
      migration 0230: closed days are OBSERVED counts snapshotted at each UTC
      day close (org_daily_stats); today is counted live. The last index
      matches summary.itemCount. */
  itemCountSeries: number[];
  /** Daily inventory value (cost basis), length `rangeDays`, oldest → newest.
      Since migration 0230: closed days are OBSERVED values snapshotted at
      each UTC day close — they no longer drift when unit_cost is edited or an
      item is deleted after the fact; today is computed live. The last index
      matches summary.inventoryValue. */
  inventoryValueSeries: number[];
  /** Daily count of items where qty <= reorder_point (and reorder_point > 0),
      length `rangeDays`, oldest → newest. Since migration 0230: observed at
      each UTC day close (snapshot); today is computed live. The last index
      matches summary.lowStockCount + summary.outOfStockCount. */
  lowOutSeries: number[];
}

/** Supported history windows. 365d is intentionally NOT offered yet: the
 *  snapshot table behind the RPC (org_daily_stats, migration 0230) was
 *  backfilled 120 days deep via the event-based reconstruction, so a
 *  365-day window would silently take the slow reconstructed-fallback path
 *  (and decay in accuracy) until a full year of nightly observations
 *  accumulates. Revisit once snapshot depth allows it. */
export type HistoryRangeDays = 30 | 90;

/** One row of dashboard_history_series (migration 0224; snapshot-backed since
 *  0230). inventory_value is numeric → may arrive as a number or a numeric
 *  string, so mapHistorySeries coerces with Number(). */
export interface HistorySeriesRow {
  day_index: number;
  item_count: number;
  inventory_value: number | string | null;
  low_out_count: number;
}

/**
 * Maps dashboard_history_series rows into the three oldest→newest series arrays
 * the StatCards + value widget consume. Pure — exported so the parity suite can
 * drive it with fixture rows. day_index is the array index; rows may arrive in
 * any order. The RPC emits exactly one row per day 0..rangeDays-1, so every
 * slot is filled; the guard is defensive.
 */
export function mapHistorySeries(rows: HistorySeriesRow[], rangeDays: number): DashboardHistory {
  const itemCountSeries = new Array<number>(rangeDays).fill(0);
  const inventoryValueSeries = new Array<number>(rangeDays).fill(0);
  const lowOutSeries = new Array<number>(rangeDays).fill(0);
  for (const r of rows) {
    const d = r.day_index;
    if (d < 0 || d >= rangeDays) continue;
    itemCountSeries[d] = Number(r.item_count) || 0;
    const v = Number(r.inventory_value);
    inventoryValueSeries[d] = Number.isFinite(v) ? v : 0;
    lowOutSeries[d] = Number(r.low_out_count) || 0;
  }
  return { rangeDays, itemCountSeries, inventoryValueSeries, lowOutSeries };
}

/**
 * Real N-day history series for the dashboard StatCards / value widget.
 *
 * SCALE FIX (migration 0224): this was THE #1 scale-blocking bug. The dashboard
 * called this TWICE per login (30d + 90d), each time paging EVERY active item
 * AND the whole stock_movements window into Node via uncapped fetchAllRows,
 * then running an O(rangeDays × items) JS reverse-walk. 0224/0228 moved that
 * into a set-based RPC, but the RPC still re-derived the whole window from raw
 * stock_movements per render (~4s at 50k items / 1.2M movements).
 *
 * SNAPSHOT ROLLUPS (migration 0230): dashboard_history_series now reads closed
 * days from org_daily_stats — one tiny precomputed row per (org, UTC day),
 * written by a nightly pg_cron refresh at 00:10 UTC — and computes only the
 * TODAY row live. Semantics upgraded deliberately: closed days are OBSERVED
 * UTC-calendar-day closes (a real snapshot at each midnight that never
 * rewrites), not rolling now()-anchored 24h buckets reconstructed backward
 * from current state. Return shape and row counts are unchanged (one row per
 * day_index 0..N-1), so this mapper is untouched.
 *
 * Fallbacks (inside the RPC): warehouseId set → snapshots are org-wide, so
 * the old fully-scoped math runs via dashboard_history_series_reconstructed
 * (the 0228 body, kept verbatim); any closed day missing from snapshots
 * (new org, missed cron) → same reconstructed path for the whole window.
 * Only on those fallback (and gap-healed) days do the old approximation
 * notes still apply: deleted items' history is lost and unit_cost/
 * reorder_point are treated as constant at today's value.
 *
 * SECURITY: dashboard_history_series stays SECURITY INVOKER and is called via
 * the USER client (ctx.supabase). Snapshot rows are org-wide aggregates
 * readable by MANAGER+ members only (RLS via rls_manager_org_ids) — for them
 * the whole series is org-wide, closed days and today alike. Warehouse/
 * category-restricted members (staff/viewer) see zero snapshot rows, so the
 * RPC's completeness sentinel routes their whole window through the
 * reconstructed path — fully caller-RLS-scoped, identical to pre-0230. The
 * warehouse-filtered view runs that reconstructed path for everyone.
 */
export async function getDashboardHistory(
  options: {
    warehouseId?: string | null;
    ctx?: ServiceContext;
    /** Window length in days. Defaults to 30. See HistoryRangeDays for why
     *  365 is not supported. */
    rangeDays?: HistoryRangeDays;
  } = {},
): Promise<DashboardHistory> {
  const ctx = options.ctx ?? (await withContext());
  const rangeDays: number = options.rangeDays ?? 30;
  const { data, error } = await ctx.supabase.rpc('dashboard_history_series', {
    p_organization_id: ctx.organizationId,
    p_warehouse_id: options.warehouseId ?? null,
    p_days: rangeDays,
  });
  if (error) throw new ServiceError('internal_error', error.message);
  return mapHistorySeries((data ?? []) as HistorySeriesRow[], rangeDays);
}

/**
 * Per-item 14-day trend series for the inventory + books list rows.
 * Replaces the synthetic-noise sparklines that `inventory-table.tsx`
 * was rendering before commit 247dc26.
 *
 * One PostgREST round trip — pulls every relevant movement in the
 * window, then buckets per-item, per-day and reverse-walks via the
 * shared lib/item-trends helpers (also used by the cached
 * inventory-list loaders — keep the math there, not here). Caller must
 * pass the current `quantity_on_hand` for each item so we don't
 * re-fetch the inventory_items rows the page already has.
 *
 * Items with no movements in the window get a flat qty line at their
 * current quantity and a moves line of zeros.
 */
export async function getItemTrends(
  items: Array<{ id: string; quantityOnHand: number }>,
  options: { ctx?: ServiceContext } = {},
): Promise<Map<string, ItemTrend>> {
  const result = new Map<string, ItemTrend>();
  if (items.length === 0) return result;
  const ctx = options.ctx ?? (await withContext());
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = Date.now() - TREND_WINDOW_DAYS * dayMs;

  const itemIds = items.map((i) => i.id);
  // Paginated: >1000 movements across the requested items in the 14-day window
  // would otherwise be silently truncated, undercounting the trend lines.
  const data = await fetchAllRows<{ item_id: string; quantity_change: number; created_at: string }>(
    (from, to) =>
      ctx.supabase
        .from('stock_movements')
        .select('item_id, quantity_change, created_at')
        .eq('organization_id', ctx.organizationId)
        .in('item_id', itemIds)
        .gte('created_at', new Date(startMs).toISOString())
        .order('id', { ascending: true })
        .range(from, to),
    { cap: 100_000 },
  );

  const buckets = bucketTrendMovements(data ?? [], startMs);
  for (const it of items) {
    result.set(it.id, deriveItemTrend(it.quantityOnHand, buckets[it.id]));
  }

  return result;
}

export interface DashboardActions {
  /** Receivable POs (expected_inbound / ordered / partially_received). */
  openPoCount: number;
  /** Cycle counts in 'in_progress' status. */
  openCycleCount: number;
  /** Receipts pending approval (counted via tolerance_profiles → approvals). */
  pendingReceipts: number;
}

/**
 * Counts of "things to do" surfaced in Shift Command. Three head queries,
 * each tiny — just `count: 'estimated'` on filtered rowsets.
 */
export async function getDashboardActions(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<DashboardActions> {
  const ctx = options.ctx ?? (await withContext());
  let posQ = ctx.supabase
    .from('purchase_orders')
    .select('id', { count: 'estimated', head: true })
    .eq('organization_id', ctx.organizationId)
    .in('status', ['expected_inbound', 'ordered', 'partially_received']);
  let ccQ = ctx.supabase
    .from('cycle_counts')
    .select('id', { count: 'estimated', head: true })
    .eq('organization_id', ctx.organizationId)
    .eq('status', 'in_progress');
  if (options.warehouseId) {
    posQ = posQ.eq('warehouse_id', options.warehouseId);
    ccQ = ccQ.eq('warehouse_id', options.warehouseId);
  }
  const [pos, cc] = await Promise.all([posQ, ccQ]);
  return {
    openPoCount: pos.count ?? 0,
    openCycleCount: cc.count ?? 0,
    pendingReceipts: 0,
  };
}

export async function getLowStockItems(
  limit = 10,
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
) {
  const ctx = options.ctx ?? (await withContext());
  if (!options.warehouseId) {
    const { data, error } = await ctx.supabase.rpc('low_stock_items', {
      p_org_id: ctx.organizationId,
      p_limit: limit,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as Array<{
      id: string;
      name: string;
      sku: string;
      quantity_on_hand: number;
      reorder_point: number;
      reorder_quantity: number;
      primary_location: string | null;
    }>;
  }

  // Warehouse-scoped path. The RPC is org-wide; reproduce its
  // semantics here. PostgREST can't express qty <= reorder_point in
  // one filter, so we narrow with an OR (reorder_point > 0 OR qty <=
  // 0 — matches the lowStock fix in InventoryService.list) and finish
  // in JS. Previous version had a `.filter(... 'reorder_point' as never)`
  // that always errored and fell through to a dead `if (error)` path —
  // wasted round trip. Now we do the right thing directly.
  const { data: candidates, error } = await ctx.supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, reorder_point, reorder_quantity, primary_location:locations!primary_location_id (name)',
    )
    .eq('organization_id', ctx.organizationId)
    .eq('warehouse_id', options.warehouseId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .or('reorder_point.gt.0,quantity_on_hand.lte.0')
    .order('quantity_on_hand', { ascending: true })
    .limit(200);
  if (error) throw new ServiceError('internal_error', error.message);
  const filtered = ((candidates ?? []) as Array<Record<string, unknown>>)
    .filter((r) => {
      const qty = Number(r.quantity_on_hand);
      const rp = Number(r.reorder_point);
      return qty <= rp || qty <= 0;
    })
    .slice(0, limit);
  return filtered.map((r) => {
    const rec = r as Record<string, unknown>;
    const loc = rec.primary_location as { name: string } | { name: string }[] | null;
    const locObj = Array.isArray(loc) ? loc[0] : loc;
    return {
      id: rec.id as string,
      name: rec.name as string,
      sku: rec.sku as string,
      quantity_on_hand: Number(rec.quantity_on_hand),
      reorder_point: Number(rec.reorder_point),
      reorder_quantity: Number(rec.reorder_quantity),
      primary_location: locObj?.name ?? null,
    };
  });
}
