/**
 * STOCK A SCOPED MEMBER CANNOT SEE: the `item_holdings_elsewhere` contract.
 *
 * ═══ WHY THIS EXISTS (migration 0371) ═══
 *
 * Since 0371 a member below manager (staff and viewers) reads
 * `item_stock_levels` only in their assigned warehouses, plus locations with no
 * warehouse. The item's `quantity_on_hand` is still the org-wide total. So any
 * screen that sums the holdings it can see and presents the result next to
 * that total ("12 placed + 20 awaiting put-away = 32 on hand") is presenting a
 * partial view as complete. Any GUARD that decides from the visible holdings
 * alone ("this item holds no stock, archive it") decides wrongly.
 *
 * The gated `SECURITY DEFINER` RPC `public.item_holdings_elsewhere(uuid[])`
 * answers the missing half as totals: per item the caller can read, the
 * Staging, Unplaced and placed quantities OUTSIDE the caller's holdings scope,
 * plus the ids of the placed locations holding them. Never a per-location
 * quantity. Visible sum + hidden sum = the item's total.
 *
 * This file is the ONE parser and the ONE vocabulary for that answer, shared by
 * the web service and the phone (which calls the same RPC through its own
 * client). Copy lives beside the archive-guard copy in `stock-writeoff.ts`.
 *
 * ═══ THE RULES EVERY CALLER FOLLOWS ═══
 *
 *   • Managers and above see every holding, so the RPC returns nothing for
 *     them and callers SKIP the call (no extra request on their screens).
 *   • At most HOLDINGS_ELSEWHERE_MAX_IDS ids per call (the RPC raises 22023
 *     'too_many_items' past it). The ids travel in the POST body, never a URL.
 *   • An item with no row has nothing hidden.
 *   • A failed call is UNAVAILABLE, never "nothing hidden": a guard refuses
 *     (fails closed), a display says it could not load stock in other
 *     warehouses instead of printing the partial math as if it were complete.
 */

/** The RPC's own bound: more ids than this raise 22023 'too_many_items'. */
export const HOLDINGS_ELSEWHERE_MAX_IDS = 500;

/** What one item holds outside the caller's holdings scope. */
export interface HoldingsElsewhere {
  /** Units in Staging locations the caller cannot see. */
  staged: number;
  /** Units in Unplaced locations the caller cannot see. */
  unplaced: number;
  /**
   * Units in every other kind of location the caller cannot see: racks,
   * crates, and NULL-kind sites (a NULL kind is a placed location, 0292).
   */
  placed: number;
  /** Sorted ids of the placed locations holding `placed`. Can be empty. */
  placedLocationIds: string[];
}

/** Everything one item holds out of view, in units. 0 for none. */
export function holdingsElsewhereTotal(h: HoldingsElsewhere | null | undefined): number {
  if (!h) return 0;
  return h.staged + h.unplaced + h.placed;
}

/**
 * The per-item state a screen renders from:
 *   • 'none'        nothing hidden (or the caller sees everything);
 *   • 'some'        these totals are hidden from the caller;
 *   • 'unavailable' the read failed, so what is hidden is unknown.
 */
export type ItemElsewhere =
  | { status: 'none' }
  | { status: 'unavailable' }
  | ({ status: 'some' } & HoldingsElsewhere);

/**
 * The state for one item out of a batch answer. `byItem` is null when the read
 * failed.
 */
export function itemElsewhereFrom(
  byItem: ReadonlyMap<string, HoldingsElsewhere> | null,
  itemId: string,
): ItemElsewhere {
  if (byItem === null) return { status: 'unavailable' };
  const h = byItem.get(itemId);
  if (!h || holdingsElsewhereTotal(h) <= 0) return { status: 'none' };
  return { status: 'some', ...h };
}

/**
 * The ids to ask about, deduplicated (blank ids dropped) and split into calls
 * of at most HOLDINGS_ELSEWHERE_MAX_IDS each.
 */
export function chunkHoldingsElsewhereIds(ids: readonly (string | null | undefined)[]): string[][] {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += HOLDINGS_ELSEWHERE_MAX_IDS) {
    out.push(unique.slice(i, i + HOLDINGS_ELSEWHERE_MAX_IDS));
  }
  return out;
}

function finiteQuantity(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`item_holdings_elsewhere returned a non-numeric ${field}`);
  }
  return n;
}

/**
 * Parse the RPC's rows into a map keyed by item id.
 *
 * THROWS on a payload that is not the documented shape: a caller that cannot
 * read the answer must treat it as unavailable, never as "nothing hidden".
 * `null` (a response with no body) parses as an empty answer, the same as `[]`.
 * `numeric` columns may arrive as strings; they are converted.
 */
export function parseHoldingsElsewhereRows(data: unknown): Map<string, HoldingsElsewhere> {
  const out = new Map<string, HoldingsElsewhere>();
  if (data === null || data === undefined) return out;
  if (!Array.isArray(data)) {
    throw new Error('item_holdings_elsewhere returned a non-array payload');
  }
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('item_holdings_elsewhere returned a malformed row');
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.item_id !== 'string' || row.item_id === '') {
      throw new Error('item_holdings_elsewhere returned a row without an item id');
    }
    const ids = Array.isArray(row.placed_location_ids)
      ? row.placed_location_ids.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    const next: HoldingsElsewhere = {
      staged: finiteQuantity(row.staged, 'staged'),
      unplaced: finiteQuantity(row.unplaced, 'unplaced'),
      placed: finiteQuantity(row.placed, 'placed'),
      placedLocationIds: ids,
    };
    // One row per item is the contract; a duplicate (two batches that both
    // named the item) is summed rather than overwritten, so nothing is lost.
    const prior = out.get(row.item_id);
    if (prior) {
      out.set(row.item_id, {
        staged: prior.staged + next.staged,
        unplaced: prior.unplaced + next.unplaced,
        placed: prior.placed + next.placed,
        placedLocationIds: [...new Set([...prior.placedLocationIds, ...next.placedLocationIds])].sort(),
      });
    } else {
      out.set(row.item_id, { ...next, placedLocationIds: [...new Set(ids)].sort() });
    }
  }
  return out;
}
