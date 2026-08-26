// "Start an order from selected items" — the client handoff between the
// Inventory Items bulk-action bar and the /dashboard/orders/new storefront.
//
// WHY A HANDOFF AND NOT A QUERY STRING: a bulk selection can be dozens of
// items; 55 UUIDs already blow past a safe URL length. The selection travels
// in sessionStorage (same tab, survives the client navigation) and is consumed
// exactly once on arrival. The target warehouse rides in the URL so the
// storefront loads the right catalog before the prefill is applied.
//
// WHY A TARGET WAREHOUSE AT ALL: an order request is single-warehouse, and the
// storefront catalog is one warehouse's orderable items. The Items list can
// span warehouses, so resolveStartOrder() picks exactly ONE and reports what
// it had to leave behind. The storefront catalog is the final authority on
// orderability (out-of-stock / bundle / rental / restricted rows are skipped
// there); this resolver only settles the warehouse and drops rows that could
// never be ordered (archived, or with no warehouse at all).

/** sessionStorage key. Versioned so a shape change can't feed a stale blob. */
export const ORDER_PREFILL_KEY = 'sp:order-prefill:v1';

export interface OrderPrefillPayload {
  warehouseId: string;
  itemIds: string[];
}

/** The subset of an Items-list row this resolver reads. */
export interface StartOrderRow {
  id: string;
  warehouse_id?: string | null;
  status?: string | null;
}

export interface ResolvedStartOrder {
  /** The single warehouse the order will be placed against. */
  warehouseId: string;
  /** Distinct item ids in that warehouse, in selection order. */
  itemIds: string[];
  totalSelected: number;
  /** Orderable rows that belong to a DIFFERENT warehouse than the target. */
  droppedOtherWarehouse: number;
  /** Rows that can never be ordered: archived, or with no warehouse. */
  droppedNotOrderable: number;
}

function isOrderable(row: StartOrderRow): boolean {
  const status = row.status ?? 'active';
  return status === 'active' && typeof row.warehouse_id === 'string' && row.warehouse_id.length > 0;
}

/**
 * Decide the target warehouse and the item ids that go into the draft.
 *
 * Target selection:
 *   - the active warehouse filter, when it is set AND holds ≥1 orderable pick
 *     (the common case — the user was already scoped to one warehouse);
 *   - otherwise the warehouse holding the MOST orderable picks (ties resolve to
 *     the first seen, i.e. selection order).
 *
 * Returns null when nothing orderable remains (caller shows a toast, navigates
 * nowhere).
 */
export function resolveStartOrder(
  rows: readonly StartOrderRow[],
  activeWarehouseId: string | null | undefined,
): ResolvedStartOrder | null {
  const totalSelected = rows.length;
  const orderable = rows.filter(isOrderable);
  const droppedNotOrderable = totalSelected - orderable.length;
  if (orderable.length === 0) return null;

  // Group by warehouse, preserving first-seen order for stable tie-breaks.
  const byWarehouse = new Map<string, string[]>();
  for (const row of orderable) {
    const wh = row.warehouse_id as string;
    const ids = byWarehouse.get(wh);
    if (ids) ids.push(row.id);
    else byWarehouse.set(wh, [row.id]);
  }

  let targetWarehouseId: string;
  if (activeWarehouseId && byWarehouse.has(activeWarehouseId)) {
    targetWarehouseId = activeWarehouseId;
  } else {
    // Majority warehouse; Map iteration is insertion order, so the first
    // group wins a tie — i.e. the earliest-selected warehouse.
    let best: string | null = null;
    let bestCount = -1;
    for (const [wh, ids] of byWarehouse) {
      if (ids.length > bestCount) {
        best = wh;
        bestCount = ids.length;
      }
    }
    targetWarehouseId = best as string;
  }

  const itemIds = [...new Set(byWarehouse.get(targetWarehouseId) ?? [])];
  const droppedOtherWarehouse = orderable.length - itemIds.length;

  return {
    warehouseId: targetWarehouseId,
    itemIds,
    totalSelected,
    droppedOtherWarehouse,
    droppedNotOrderable,
  };
}

/**
 * Which prefilled ids can actually enter the cart, given the storefront's
 * resolved catalog for its warehouse. The catalog is the authority: an id
 * that isn't in it (wrong warehouse, bundle, rental, awaiting first receipt,
 * restricted category) or has zero available stock is skipped. Pure so the
 * storefront's one-shot effect stays trivially testable.
 */
export function partitionPrefillAgainstCatalog(
  itemIds: readonly string[],
  catalog: readonly { id: string; quantityOnHand: number; reservedQuantity: number }[],
): { addable: string[]; skipped: number } {
  const availableById = new Map<string, number>();
  for (const c of catalog) {
    availableById.set(c.id, Math.max(0, c.quantityOnHand - c.reservedQuantity));
  }
  const addable = [...new Set(itemIds)].filter((id) => (availableById.get(id) ?? 0) > 0);
  return { addable, skipped: new Set(itemIds).size - addable.length };
}

/**
 * Write the handoff. Client-only; every access is guarded because
 * sessionStorage throws in private-mode / sandboxed contexts.
 */
export function writeOrderPrefill(payload: OrderPrefillPayload): boolean {
  try {
    sessionStorage.setItem(ORDER_PREFILL_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the handoff for a given warehouse and clear it (one-shot). Returns null
 * when nothing is pending, the blob is corrupt, or it targets a DIFFERENT
 * warehouse than the one asked for — in the mismatch case the blob is LEFT in
 * place so a correct-warehouse load can still consume it.
 */
export function takeOrderPrefill(expectedWarehouseId: string): OrderPrefillPayload | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(ORDER_PREFILL_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: OrderPrefillPayload | null = null;
  try {
    const obj = JSON.parse(raw) as OrderPrefillPayload;
    if (obj && typeof obj.warehouseId === 'string' && Array.isArray(obj.itemIds)) {
      parsed = {
        warehouseId: obj.warehouseId,
        itemIds: obj.itemIds.filter((x): x is string => typeof x === 'string'),
      };
    }
  } catch {
    parsed = null;
  }

  // Corrupt blob: clear it so it can't wedge future loads.
  if (!parsed) {
    try {
      sessionStorage.removeItem(ORDER_PREFILL_KEY);
    } catch {
      /* noop */
    }
    return null;
  }

  // Targets another warehouse — leave it for the right load.
  if (parsed.warehouseId !== expectedWarehouseId) return null;

  try {
    sessionStorage.removeItem(ORDER_PREFILL_KEY);
  } catch {
    /* noop */
  }
  return parsed;
}
