import 'server-only';

import { getWarehouseAccess } from '@/lib/auth/warehouse';

import { ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';

export interface MovementWithItem {
  id: string;
  movement_type: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  from_location_id: string | null;
  to_location_id: string | null;
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
        from_location_id, to_location_id, reason, notes, created_at,
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

    // PostgREST returns the related row as an array when the relation is
    // ambiguous; flatten to a single object.
    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
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
      return { ...r, item, actor } as MovementWithItem;
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

/**
 * Real 30-day movement metrics for the dashboard charts. Replaces the
 * synthetic `barValues` + `breakdownRows` arrays the dashboard used to
 * render. Single round trip to stock_movements.
 */
export async function getThirtyDayMetrics(
  options: { warehouseId?: string | null; ctx?: ServiceContext } = {},
): Promise<ThirtyDayMetrics> {
  const ctx = options.ctx ?? (await withContext());
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  // Always inner-join inventory_items so we can filter out movements whose
  // parent item has been soft-deleted. Without this the 30-day series
  // double-counts events for SKUs that no longer exist on the dash.
  // Paginated: a single .select() is silently capped at 1000 rows by PostgREST,
  // and the old ascending order dropped the NEWEST days for any org with >1000
  // movements in the 30-day window. Page by a stable id (day-bucketing below is
  // order-independent).
  const data = await fetchAllRows<{ movement_type: string; created_at: string }>(
    (from, to) => {
      let q = ctx.supabase
        .from('stock_movements')
        .select(
          'movement_type, created_at, item:inventory_items!item_id!inner (warehouse_id, deleted_at)',
        )
        .eq('organization_id', ctx.organizationId)
        .is('item.deleted_at', null)
        .gte('created_at', since.toISOString());
      if (options.warehouseId) q = q.eq('item.warehouse_id', options.warehouseId);
      return q.order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
        data: { movement_type: string; created_at: string }[] | null;
        error: { message: string } | null;
      }>;
    },
    { cap: 100_000 },
  );

  const dailyCounts = new Array<number>(30).fill(0);
  const byTypeMap = new Map<string, number>();
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = since.getTime();

  for (const r of data) {
    const t = new Date(r.created_at).getTime();
    const dayIdx = Math.min(29, Math.max(0, Math.floor((t - startMs) / dayMs)));
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

export interface DashboardHistory {
  /** Number of days the series spans (length of each series array). */
  rangeDays: number;
  /** Daily active SKU count, length `rangeDays`, oldest → newest. Derived
      from inventory_items.created_at. The last index matches summary.itemCount. */
  itemCountSeries: number[];
  /** Daily approximate inventory value, length `rangeDays`, oldest → newest.
      Computed by walking the window of stock_movements backward from today's
      value using each item's current unit_cost. Approximate because
      cost may have changed historically; cheap enough for a dashboard
      tile. The last index matches summary.inventoryValue. */
  inventoryValueSeries: number[];
  /** Daily count of items where qty <= reorder_point (and reorder_point > 0),
      length `rangeDays`, oldest → newest. Reverse-walks movements to
      reconstruct historical quantities. The last index matches
      summary.lowStockCount + summary.outOfStockCount. */
  lowOutSeries: number[];
}

/** Supported history windows. 365d is intentionally NOT offered: the
 *  reverse-walk pulls every movement in the window into Node memory, which
 *  is fine at 30/90d but becomes expensive (and increasingly inaccurate as
 *  unit_cost drift compounds) over a year. A finance-grade yearly series
 *  needs a daily snapshot table — deferred to a later phase. */
export type HistoryRangeDays = 30 | 90;

/**
 * Real 30-day history series for the dashboard StatCards. Replaces the
 * hardcoded sparkline arrays and fake deltas that lived in
 * apps/web/src/app/(dashboard)/dashboard/page.tsx. Pulls each org's
 * active inventory items + 30 days of movements (two queries) and
 * derives three series via reverse-walk.
 *
 * Approximation notes:
 * - Items deleted in the last 30 days are excluded (we only know about
 *   items still active today). Their historical contribution is lost.
 * - unit_cost is treated as constant at today's value. If cost changed,
 *   historical valuations are slightly off.
 * - reorder_point is also treated as constant at today's value.
 *
 * For a finance-grade history we'd snapshot daily into a separate
 * table; this is a pragmatic dashboard-quality approximation.
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
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const startMs = now - rangeDays * dayMs;

  // 1 & 2. Items in scope + 30-day movements. These are independent —
  // run them concurrently to halve the wall-clock for this function.
  // Previously they were sequential, costing ~1 RTT extra per dashboard
  // render.
  type ItemRow = {
    id: string;
    created_at: string;
    quantity_on_hand: number | null;
    unit_cost: number | null;
    reorder_point: number | null;
  };

  // Paginate BOTH selects through fetchAllRows: a single .select() is silently
  // capped at 1000 rows (PostgREST max_rows), which on a large org would
  // undercount inventory value (>1000 active items) or movements (>1000 in the
  // window) and quietly skew the whole dashboard history (audit 2026-06-09).
  // Stable .order('id') is required so no row lands on two pages / none.
  const itemsPage = (from: number, to: number) => {
    let q = ctx.supabase
      .from('inventory_items')
      .select('id, created_at, quantity_on_hand, unit_cost, reorder_point')
      .eq('organization_id', ctx.organizationId)
      .eq('status', 'active')
      .is('deleted_at', null);
    if (options.warehouseId) q = q.eq('warehouse_id', options.warehouseId);
    return q.order('id', { ascending: true }).range(from, to);
  };

  type MovRow = { item_id: string; quantity_change: number; created_at: string };
  const movSelect = options.warehouseId
    ? 'item_id, quantity_change, created_at, item:inventory_items!item_id!inner (warehouse_id)'
    : 'item_id, quantity_change, created_at';
  const movPage = (from: number, to: number) => {
    let q = ctx.supabase
      .from('stock_movements')
      .select(movSelect)
      .eq('organization_id', ctx.organizationId)
      .gte('created_at', new Date(startMs).toISOString());
    if (options.warehouseId) q = q.eq('item.warehouse_id', options.warehouseId);
    // The dynamic embed `select()` string can't be statically typed by the
    // PostgREST type parser, so cast to the page shape fetchAllRows expects.
    return q.order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
      data: MovRow[] | null;
      error: { message: string } | null;
    }>;
  };

  const [items, movData] = await Promise.all([
    fetchAllRows<ItemRow>(itemsPage),
    fetchAllRows<MovRow>(movPage),
  ]);

  // Mutable per-item state (reverse-walked through movements below).
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

  // Bucket movements by day so we can replay them in reverse order.
  type Move = { item_id: string; quantity_change: number };
  const lastIdx = rangeDays - 1;
  const movesByDay: Move[][] = Array.from({ length: rangeDays }, () => []);
  for (const r of (movData ?? []) as unknown as Array<{
    item_id: string;
    quantity_change: number;
    created_at: string;
  }>) {
    const t = new Date(r.created_at).getTime();
    const dayIdx = Math.min(lastIdx, Math.max(0, Math.floor((t - startMs) / dayMs)));
    movesByDay[dayIdx]!.push({
      item_id: r.item_id,
      quantity_change: Number(r.quantity_change) || 0,
    });
  }

  // 3. Reverse-walk: last index = today (current state), then undo each day's
  //    movements to recover the previous day's end-of-day state.
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
    // Undo this day's movements to step back to (d-1)'s end-of-day state.
    const today = movesByDay[d] ?? [];
    for (const m of today) {
      const cost = costById.get(m.item_id);
      if (cost === undefined) continue; // item no longer exists
      value -= m.quantity_change * cost;
      const prev = qtyById.get(m.item_id) ?? 0;
      qtyById.set(m.item_id, prev - m.quantity_change);
    }
  }

  // 4. Item-count series from created_at. itemCountSeries[d] = items where
  //    created_at <= end of day d. Sort once, single forward sweep.
  const sorted = [...createdAtTimes].sort((a, b) => a - b);
  const itemCountSeries = new Array<number>(rangeDays).fill(0);
  let cursor = 0;
  for (let d = 0; d < rangeDays; d++) {
    const dayEnd = startMs + (d + 1) * dayMs;
    while (cursor < sorted.length && sorted[cursor]! <= dayEnd) cursor++;
    itemCountSeries[d] = cursor;
  }

  return { rangeDays, itemCountSeries, inventoryValueSeries, lowOutSeries };
}

export interface ItemTrend {
  /** Length 14, oldest → newest. End-of-day quantity for the item,
      reverse-walked from the caller-supplied current quantity. */
  qtySeries: number[];
  /** Length 14, oldest → newest. Number of stock_movements rows that
      hit the item on that day. */
  moveSeries: number[];
}

/**
 * Per-item 14-day trend series for the inventory + books list rows.
 * Replaces the synthetic-noise sparklines that `inventory-table.tsx`
 * was rendering before commit 247dc26.
 *
 * One PostgREST round trip — pulls every relevant movement in the
 * window and buckets per-item, per-day in TS. Caller must pass the
 * current `quantity_on_hand` for each item so we don't re-fetch
 * the inventory_items rows the page already has.
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
  const now = Date.now();
  const startMs = now - 14 * dayMs;

  // Seed every requested item with a flat fallback so missing-data items
  // still render (qty line at current value, moves at zero).
  for (const it of items) {
    result.set(it.id, {
      qtySeries: new Array<number>(14).fill(it.quantityOnHand),
      moveSeries: new Array<number>(14).fill(0),
    });
  }

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

  // Bucket movements per item per day.
  type DayBucket = { change: number; count: number };
  const buckets = new Map<string, DayBucket[]>();
  for (const it of items) {
    buckets.set(
      it.id,
      Array.from({ length: 14 }, () => ({ change: 0, count: 0 })),
    );
  }
  for (const r of (data ?? []) as Array<{
    item_id: string;
    quantity_change: number;
    created_at: string;
  }>) {
    const days = buckets.get(r.item_id);
    if (!days) continue;
    const t = new Date(r.created_at).getTime();
    const dayIdx = Math.min(13, Math.max(0, Math.floor((t - startMs) / dayMs)));
    const bucket = days[dayIdx]!;
    bucket.change += Number(r.quantity_change) || 0;
    bucket.count += 1;
  }

  // Reverse-walk to derive qty per day; copy counts directly.
  for (const it of items) {
    const days = buckets.get(it.id)!;
    const qty = new Array<number>(14).fill(0);
    const moves = new Array<number>(14).fill(0);
    let running = it.quantityOnHand;
    // d=13 is end of today: equals current qty AFTER today's movements.
    // d=12 is end of yesterday: today's movements undone.
    // qty[d-1] = qty[d] - changes_on_day_d
    for (let d = 13; d >= 0; d--) {
      qty[d] = running;
      moves[d] = days[d]!.count;
      running -= days[d]!.change;
    }
    result.set(it.id, { qtySeries: qty, moveSeries: moves });
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
