// Pure 14-day item-trend math, shared by:
//   • movements.ts getItemTrends() — the live path (fetches only the
//     requested items' movements, then buckets + derives here), and
//   • loaders/inventory-list.ts — the cached path (fills ORG-WIDE
//     buckets once per org via the inventory_trend_buckets SQL aggregate
//     — migration 0223, mapped here by bucketsFromTrendAggregates — then
//     derives per request for whatever rows the current filter surfaced).
// Keeping the bucketing + reverse-walk in ONE place is what guarantees
// the cached filtered views and the live path produce identical series
// for identical inputs. No imports (not even 'server-only') so the
// loader tests can run the real math instead of re-stubbing it.

/** Length of the sparkline window on the Items/Books list rows. */
export const TREND_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ItemTrend {
  /** Length 14, oldest → newest. End-of-day quantity for the item,
      reverse-walked from the caller-supplied current quantity. */
  qtySeries: number[];
  /** Length 14, oldest → newest. Number of stock_movements rows that
      hit the item on that day. */
  moveSeries: number[];
}

/** One day's aggregated movement activity for one item. */
export interface TrendDayBucket {
  /** Sum of quantity_change across the day's movements. */
  change: number;
  /** Number of movement rows that day. */
  count: number;
}

/**
 * Serialized per-item day buckets (plain arrays/objects — Maps don't
 * survive Next's data cache).
 */
export type ItemTrendBuckets = Record<string, TrendDayBucket[]>;

/**
 * Buckets raw stock_movements rows per item per day. `startMs` anchors
 * day 0 (now − 14d at query time); rows outside the window clamp into
 * the edge buckets exactly like the original getItemTrends loop did.
 * Items with no rows simply have no entry — deriveItemTrend treats a
 * missing bucket array as "no movements" (flat series).
 */
export function bucketTrendMovements(
  rows: ReadonlyArray<{ item_id: string; quantity_change: number; created_at: string }>,
  startMs: number,
): ItemTrendBuckets {
  const buckets: ItemTrendBuckets = {};
  for (const r of rows) {
    const days = (buckets[r.item_id] ??= Array.from({ length: TREND_WINDOW_DAYS }, () => ({
      change: 0,
      count: 0,
    })));
    const t = new Date(r.created_at).getTime();
    const dayIdx = Math.min(
      TREND_WINDOW_DAYS - 1,
      Math.max(0, Math.floor((t - startMs) / DAY_MS)),
    );
    const bucket = days[dayIdx]!;
    bucket.change += Number(r.quantity_change) || 0;
    bucket.count += 1;
  }
  return buckets;
}

/**
 * One row of the SQL aggregate `inventory_trend_buckets` (migration
 * 0223): per (item, day-bucket) sums over the same window/clamp math as
 * bucketTrendMovements. numeric/bigint may arrive from PostgREST as
 * strings depending on the client — both fields are coerced on mapping.
 */
export interface TrendAggregateRow {
  item_id: string;
  day_index: number;
  quantity_change: number | string;
  move_count: number | string;
}

/**
 * Maps the RPC's aggregate rows into the exact ItemTrendBuckets shape
 * bucketTrendMovements produces from raw rows (asserted bucket-for-bucket
 * by the parity test in loaders/inventory-list.test.ts): items with any
 * aggregate row get a full TREND_WINDOW_DAYS array with untouched days at
 * {change: 0, count: 0}; items with no rows get no entry (deriveItemTrend
 * treats that as "no movements" — flat series). day_index is re-clamped
 * defensively; the SQL already clamps identically.
 */
export function bucketsFromTrendAggregates(
  rows: ReadonlyArray<TrendAggregateRow>,
): ItemTrendBuckets {
  const buckets: ItemTrendBuckets = {};
  for (const r of rows) {
    const days = (buckets[r.item_id] ??= Array.from({ length: TREND_WINDOW_DAYS }, () => ({
      change: 0,
      count: 0,
    })));
    const idx = Math.min(
      TREND_WINDOW_DAYS - 1,
      Math.max(0, Math.floor(Number(r.day_index) || 0)),
    );
    const bucket = days[idx]!;
    bucket.change += Number(r.quantity_change) || 0;
    bucket.count += Number(r.move_count) || 0;
  }
  return buckets;
}

/**
 * Reverse-walks one item's series from its CURRENT quantity:
 * day 13 = end of today (equals current qty after today's movements),
 * qty[d−1] = qty[d] − changes_on_day_d. An item with no buckets gets a
 * flat qty line at its current quantity and a moves line of zeros —
 * the same fallback getItemTrends has always used.
 */
export function deriveItemTrend(
  quantityOnHand: number,
  days: TrendDayBucket[] | undefined,
): ItemTrend {
  const qty = new Array<number>(TREND_WINDOW_DAYS).fill(quantityOnHand);
  const moves = new Array<number>(TREND_WINDOW_DAYS).fill(0);
  if (!days) return { qtySeries: qty, moveSeries: moves };
  let running = quantityOnHand;
  for (let d = TREND_WINDOW_DAYS - 1; d >= 0; d--) {
    qty[d] = running;
    moves[d] = days[d]?.count ?? 0;
    running -= days[d]?.change ?? 0;
  }
  return { qtySeries: qty, moveSeries: moves };
}
