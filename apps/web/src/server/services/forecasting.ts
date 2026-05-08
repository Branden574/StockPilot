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
  const qty = Number(item.quantity_on_hand) || 0;

  // Cap window to the item's actual age so a 5-day-old item doesn't
  // get its velocity diluted across a 90-day denominator.
  const itemAgeDays = Math.max(
    1,
    Math.floor((Date.now() - new Date(item.created_at).getTime()) / DAY_MS),
  );
  const effectiveWindow = Math.min(windowDays, itemAgeDays);

  const unitsOutTotal = moves.reduce(
    (s, m) => s + Math.abs(Number((m as { quantity_change: number }).quantity_change) || 0),
    0,
  );
  const unitsOutPerDay = effectiveWindow > 0 ? unitsOutTotal / effectiveWindow : 0;

  let daysOfStockRemaining: number | null = null;
  let projectedRunoutAt: string | null = null;
  if (unitsOutPerDay > 0 && qty > 0) {
    daysOfStockRemaining = Math.floor(qty / unitsOutPerDay);
    projectedRunoutAt = new Date(Date.now() + daysOfStockRemaining * DAY_MS).toISOString();
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
  const leadTimeDays = options.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
  const safetyMultiplier = options.safetyMultiplier ?? DEFAULT_SAFETY_MULTIPLIER;
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

  const currentReorderPoint = Number(
    (item as { reorder_point: number | null }).reorder_point ?? 0,
  );
  const currentReorderQty = Number(
    (item as { reorder_quantity: number | null }).reorder_quantity ?? 0,
  );

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
      `${(safetyMultiplier - 1) * 100}% safety buffer. Reorder qty ${suggestedReorderQty} ` +
      `covers the next ~${DEFAULT_REORDER_QTY_DAYS} days of demand.`;
  }

  return {
    itemId,
    suggestedReorderPoint,
    suggestedReorderQty,
    currentReorderPoint,
    currentReorderQty,
    velocity,
    leadTimeDays,
    safetyMultiplier,
    rationale,
  };
}
