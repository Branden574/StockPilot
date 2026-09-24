/**
 * The cycle-count HISTORY list: what one page holds, which statuses it can be
 * filtered to, and how a count's scope is labelled. Shared by the web page,
 * the /api/v1 list route and the phone, so no platform can quietly show 50 or
 * 200 while another shows 25.
 *
 * The page size is the number of count SESSIONS on a page. It has nothing to
 * do with the lines inside one count, which the detail page pages separately.
 */

/** Count sessions per history page, on every platform. */
export const CYCLE_COUNT_PAGE_SIZE = 25;

/** The lifecycle states a count can be in (the cycle_counts status check). */
export const CYCLE_COUNT_STATUSES = ['in_progress', 'completed', 'canceled'] as const;
export type CycleCountStatusValue = (typeof CYCLE_COUNT_STATUSES)[number];

/** Human labels for the status filter and badges. */
export const CYCLE_COUNT_STATUS_LABELS: Record<CycleCountStatusValue, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  canceled: 'Canceled',
};

/** A `?status=` value -> a real status, or null for "all statuses" (the
 *  default, so completed and canceled history is findable). */
export function parseCycleCountStatusFilter(raw: unknown): CycleCountStatusValue | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === 'string' && (CYCLE_COUNT_STATUSES as readonly string[]).includes(first)
    ? (first as CycleCountStatusValue)
    : null;
}

/**
 * What a count covers, in words.
 *
 *   • A header warehouse -> that warehouse's name.
 *   • No header warehouse on a WAREHOUSE-scope count -> "All warehouses":
 *     it really did snapshot every warehouse.
 *   • No header warehouse on a SELECTION -> "Selected items". A hand-picked
 *     selection whose picks span warehouses (or have none) is stored with a
 *     null header warehouse, and calling that "All warehouses" would claim a
 *     count of the whole org that never happened.
 *   • A header warehouse whose name the viewer cannot read (archived, or
 *     outside their scope) -> "Warehouse unavailable", never a blank.
 */
export function cycleCountScopeLabel(count: {
  warehouseId: string | null;
  warehouseName: string | null;
  scope: string | null;
}): string {
  if (count.warehouseId) {
    return count.warehouseName?.trim() || 'Warehouse unavailable';
  }
  return count.scope === 'selection' ? 'Selected items' : 'All warehouses';
}
