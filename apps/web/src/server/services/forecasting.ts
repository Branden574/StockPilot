import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ServiceError } from './context';

export interface VelocitySnapshot {
  itemId: string;
  /** Average outbound units per day, computed over the lookback window. */
  unitsOutPerDay: number;
  /** Total units out in the window — denominator + sanity cue. */
  unitsOutTotal: number;
  /** Length of the lookback window. */
  windowDays: number;
  /** Current quantity_on_hand, snapshotted with the velocity calc. */
  quantityOnHand: number;
  /** unitsOutPerDay > 0 ? floor(qty / unitsOutPerDay) : null. Null = no movement. */
  daysOfStockRemaining: number | null;
  /** ISO date when projected to hit zero at current velocity, or null. */
  projectedRunoutAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_LEAD_TIME_DAYS = 14;
const DEFAULT_SAFETY_MULTIPLIER = 1.5;
const DEFAULT_REORDER_QTY_DAYS = 30;

/**
 * Pure velocity math for one item, given its quantity_on_hand + created_at and
 * the total outbound units seen in the window. No DB access — callers supply
 * the aggregated movement total, which lets a single-item or a bulk caller
 * share identical math. The window is capped to the item's age so a brand-new
 * item isn't diluted across the full lookback.
 */
export function computeVelocitySnapshot(
  itemId: string,
  quantityOnHand: number,
  createdAt: string,
  unitsOutTotal: number,
  windowDays: number,
  now = Date.now(),
): VelocitySnapshot {
  const qty = Number(quantityOnHand) || 0;
  const itemAgeDays = Math.max(
    1,
    Math.floor((now - new Date(createdAt).getTime()) / DAY_MS),
  );
  const effectiveWindow = Math.min(windowDays, itemAgeDays);
  const unitsOutPerDay = effectiveWindow > 0 ? unitsOutTotal / effectiveWindow : 0;

  let daysOfStockRemaining: number | null = null;
  let projectedRunoutAt: string | null = null;
  if (unitsOutPerDay > 0 && qty > 0) {
    daysOfStockRemaining = Math.floor(qty / unitsOutPerDay);
    projectedRunoutAt = new Date(now + daysOfStockRemaining * DAY_MS).toISOString();
  }

  return {
    itemId,
    unitsOutPerDay,
    unitsOutTotal,
    windowDays: effectiveWindow,
    quantityOnHand: qty,
    daysOfStockRemaining,
    projectedRunoutAt,
  };
}

/**
 * Pure reorder math from a velocity snapshot + current DB values. Shared by the
 * single-item and bulk suggestion paths so the formula lives in exactly one
 * place. Read-only: returns the recommendation; the caller decides to apply it.
 */
export function computeReorderSuggestion(
  velocity: VelocitySnapshot,
  currentReorderPoint: number,
  currentReorderQty: number,
  options: { leadTimeDays?: number; safetyMultiplier?: number } = {},
): ReorderSuggestion {
  const leadTimeDays = options.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
  const safetyMultiplier = options.safetyMultiplier ?? DEFAULT_SAFETY_MULTIPLIER;

  let suggestedReorderPoint = 0;
  let suggestedReorderQty = 0;
  let rationale: string;

  if (velocity.unitsOutPerDay <= 0) {
    rationale = `No outbound movement in the last ${velocity.windowDays} days — keeping reorder point at zero. Item may be dead stock or pre-launch.`;
  } else {
    suggestedReorderPoint = Math.ceil(
      velocity.unitsOutPerDay * leadTimeDays * safetyMultiplier,
    );
    suggestedReorderQty = Math.ceil(velocity.unitsOutPerDay * DEFAULT_REORDER_QTY_DAYS);
    rationale =
      `At ${velocity.unitsOutPerDay.toFixed(2)} units/day over ${velocity.windowDays} days, ` +
      `you'll burn ${(velocity.unitsOutPerDay * leadTimeDays).toFixed(0)} units during a ` +
      `${leadTimeDays}-day lead time. Reorder point ${suggestedReorderPoint} adds a ` +
      `${Math.round((safetyMultiplier - 1) * 100)}% safety buffer. Reorder qty ${suggestedReorderQty} ` +
      `covers the next ~${DEFAULT_REORDER_QTY_DAYS} days of demand.`;
  }

  return {
    itemId: velocity.itemId,
    suggestedReorderPoint,
    suggestedReorderQty,
    currentReorderPoint: Number(currentReorderPoint ?? 0),
    currentReorderQty: Number(currentReorderQty ?? 0),
    velocity,
    leadTimeDays,
    safetyMultiplier,
    rationale,
  };
}

/**
 * Compute the velocity snapshot for a single item. "Out" is any
 * stock_movements row with quantity_change < 0 — sales, transfers
 * out, damage, shrinkage, manual remove. The denominator is the
 * actual lookback window (capped to item's age in the system so
 * we don't dilute brand-new items by a 90-day average).
 */
export async function getItemVelocity(
  supabase: SupabaseClient,
  orgId: string,
  itemId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<VelocitySnapshot> {
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  const [movesRes, itemRes] = await Promise.all([
    supabase
      .from('stock_movements')
      .select('quantity_change, created_at')
      .eq('organization_id', orgId)
      .eq('item_id', itemId)
      .lt('quantity_change', 0)
      .gte('created_at', since),
    supabase
      .from('inventory_items')
      .select('quantity_on_hand, created_at')
      .eq('organization_id', orgId)
      .eq('id', itemId)
      .maybeSingle(),
  ]);
  if (movesRes.error) throw new ServiceError('internal_error', movesRes.error.message);
  if (itemRes.error) throw new ServiceError('internal_error', itemRes.error.message);
  if (!itemRes.data) throw new ServiceError('not_found', 'Item not found');

  const moves = movesRes.data ?? [];
  const item = itemRes.data as { quantity_on_hand: number; created_at: string };

  const unitsOutTotal = moves.reduce(
    (s, m) => s + Math.abs(Number((m as { quantity_change: number }).quantity_change) || 0),
    0,
  );

  return computeVelocitySnapshot(
    itemId,
    item.quantity_on_hand,
    item.created_at,
    unitsOutTotal,
    windowDays,
  );
}

/** Minimal item shape the bulk velocity path needs from the caller. */
export interface BulkVelocityItem {
  id: string;
  quantity_on_hand: number | null;
  created_at: string;
}

/**
 * Bulk velocity for a candidate set in a SINGLE stock_movements query. The
 * caller already holds the item rows (with quantity_on_hand + created_at), so
 * this issues exactly one round-trip: aggregate outbound units per item over
 * the window, then compute each snapshot in memory. No per-item DB fan-out —
 * this is the pattern the planning surface uses to stay flat for large catalogs.
 */
export async function getBulkItemVelocities(
  supabase: SupabaseClient,
  orgId: string,
  items: BulkVelocityItem[],
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<Map<string, VelocitySnapshot>> {
  const result = new Map<string, VelocitySnapshot>();
  if (items.length === 0) return result;

  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  // Sum |quantity_change| per item over the window. PostgREST caps a response at
  // max_rows (1000), so a single un-paginated scan would SILENTLY undercount any
  // org with >1000 outbound movements in the window — making every velocity (and
  // thus every reorder suggestion) come out too low. Page through in 1000-row
  // chunks and accumulate until a short page signals the end (same pattern as
  // order-requests / valuation / the outbox drainer).
  //
  // Filtered by org + outbound + window only (no `item_id IN (...)` — that list
  // can be 5000 uuids and blow the query-string limit). Movements for items
  // outside the candidate set just add unused entries to `totals`; we only read
  // totals.get(item.id) for our candidates below, so they're harmless.
  const PAGE = 1000;
  const totals = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('item_id, quantity_change')
      .eq('organization_id', orgId)
      .lt('quantity_change', 0)
      .gte('created_at', since)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = (data ?? []) as Array<{ item_id: string; quantity_change: number }>;
    for (const m of rows) {
      const out = Math.abs(Number(m.quantity_change) || 0);
      totals.set(m.item_id, (totals.get(m.item_id) ?? 0) + out);
    }
    if (rows.length < PAGE) break;
  }

  const now = Date.now();
  for (const item of items) {
    result.set(
      item.id,
      computeVelocitySnapshot(
        item.id,
        item.quantity_on_hand ?? 0,
        item.created_at,
        totals.get(item.id) ?? 0,
        windowDays,
        now,
      ),
    );
  }
  return result;
}

export interface ReorderSuggestion {
  itemId: string;
  /** Suggested reorder_point in units. */
  suggestedReorderPoint: number;
  /** Suggested reorder_quantity in units. */
  suggestedReorderQty: number;
  /** Current reorder_point in the DB — for comparison. */
  currentReorderPoint: number;
  /** Current reorder_quantity in the DB — for comparison. */
  currentReorderQty: number;
  /** Velocity input that drove the math. */
  velocity: VelocitySnapshot;
  /** Lead time used in the calc (days). */
  leadTimeDays: number;
  /** Safety-stock multiplier used. */
  safetyMultiplier: number;
  /** Plain-English explanation of the recommendation. */
  rationale: string;
}

/**
 * Recommend a reorder_point + reorder_quantity for an item based on
 * its actual velocity. Formula:
 *
 *   suggestedReorderPoint = ceil(unitsPerDay × leadTimeDays × safetyMultiplier)
 *   suggestedReorderQty   = ceil(unitsPerDay × DEFAULT_REORDER_QTY_DAYS)
 *
 * Items with no out-movement get a zero suggestion (no point reordering
 * what isn't moving). Caller decides whether to apply or not — this
 * function is read-only.
 */
export async function suggestReorderPoint(
  supabase: SupabaseClient,
  orgId: string,
  itemId: string,
  options: {
    leadTimeDays?: number;
    safetyMultiplier?: number;
    windowDays?: number;
  } = {},
): Promise<ReorderSuggestion> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

  const velocity = await getItemVelocity(supabase, orgId, itemId, windowDays);

  const { data: item, error } = await supabase
    .from('inventory_items')
    .select('reorder_point, reorder_quantity')
    .eq('organization_id', orgId)
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  if (!item) throw new ServiceError('not_found', 'Item not found');

  return computeReorderSuggestion(
    velocity,
    Number((item as { reorder_point: number | null }).reorder_point ?? 0),
    Number((item as { reorder_quantity: number | null }).reorder_quantity ?? 0),
    { leadTimeDays: options.leadTimeDays, safetyMultiplier: options.safetyMultiplier },
  );
}
