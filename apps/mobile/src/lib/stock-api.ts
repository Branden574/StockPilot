import { api } from './api';

/**
 * Typed wrapper over the mobile `api()` client for MOVING stock between
 * locations — the native parity for the web StockTransferDialog and the Staging
 * put-away flow.
 *
 * POSTs to /api/v1/items/<id>/transfer, which routes through
 * InventoryService.transferStock so the 'stock:transfer' PERMISSION is enforced
 * server-side. (The raw transfer_stock RPC only checks the staff-role floor, so
 * mobile must never call it directly — it would let a member without
 * stock:transfer move stock.)
 *
 * One call serves BOTH cases; the only difference is which source holding you
 * pick:
 *   • transfer  — source is a placed rack/crate,
 *   • put-away  — source is a staging/unplaced bucket.
 *
 * The destination is EITHER an existing location (`toLocationId`) OR a rack/crate
 * created inline (`newRack`) — exactly one. The new rack is created server-side
 * in the source location's warehouse (asserts 'locations:manage').
 */
/**
 * The inline-created destination. RACK **XOR** CRATE — the server refuses a
 * body carrying both (packages/core/src/inventory/new-location.ts), because
 * "rack A1 + crate 9" has no honest name and guessing one is what minted a
 * surprise "Crate #9" from a sheet that had confirmed "Create new rack A1?".
 * A crate is identified by its NUMBER; the colour is optional.
 */
export type NewRack =
  | { rackNumber: string; rackRow?: string; crateColor?: never; crateNumber?: never }
  | { crateNumber: string; crateColor?: string; rackNumber?: never; rackRow?: never };

export interface TransferStockBody {
  fromLocationId: string;
  quantity: number;
  notes?: string;
  /** Existing destination. Provide this OR `newRack`, not both. */
  toLocationId?: string;
  /** Create-and-move destination. Provide this OR `toLocationId`, not both. */
  newRack?: NewRack;
  /**
   * The answer to a BOOK_CRATE_CHANGE_REQUIRES_CONFIRMATION refusal: one entry
   * per book, its id plus the fingerprint of the crate the sheet DISPLAYED.
   * Never a blanket flag — a fingerprint that no longer matches the row is not
   * an acknowledgement of the change the server found.
   */
  acknowledgedCrateChanges?: Array<{ itemId: string; currentFingerprint: string }>;
}

/** What the transfer route reports back about the book's crate LABEL. The stock
 *  moved in every case; these say whether the summary followed it. */
export interface TransferStockResult {
  toLocationId?: string;
  crateSyncFailed?: boolean;
  crateSyncSkipped?: boolean;
  crateSyncStale?: boolean;
  /** No placed holding left after the move, so the summary had nothing to
   *  follow and was left alone — it may now name a crate holding none of it. */
  crateSyncUnplaced?: boolean;
}

/**
 * Move stock.
 *
 * Rethrown as-is on a non-2xx: `api()` already raises an `ApiError` carrying
 * the server's friendly `message` AND its APP-AUTHORED `details` blob, and that
 * blob is what lets a caller RE-ASK a refusal instead of only reporting it —
 * specifically the book-crate confirmation the transfer route now gates on.
 * Wrapping it in a plain Error (which is what this used to do) flattened the
 * payload to a sentence and made the confirmation unofferable.
 */
export async function transferStock(
  itemId: string,
  body: TransferStockBody,
): Promise<TransferStockResult> {
  return ((await api(`/api/v1/items/${itemId}/transfer`, {
    method: 'POST',
    body,
  })) ?? {}) as TransferStockResult;
}

export interface RemoveStockBody {
  /** The holding (rack/crate) to draw down. */
  locationId: string;
  /** MANDATORY — stored verbatim on the 'remove' movement. */
  reason: string;
  /** Omit to remove the WHOLE holding (resolved server-side); a positive value
   *  removes exactly that much, capped at the holding by the service. */
  quantity?: number;
}

/**
 * Remove (write off) stock from ONE rack — native parity for the web
 * RemoveFromRackDialog. POSTs to /api/v1/items/<id>/remove-stock, which routes
 * through InventoryService.removeStockFromLocation → adjustStock so the
 * 'stock:adjust' PERMISSION is enforced server-side (the raw adjust_stock RPC
 * only checks the staff-role floor). Leaves stock in every OTHER location
 * untouched — unlike archive, which would hide the whole item and orphan it.
 *
 * Throws a clean Error (the server's friendly message) on a non-2xx.
 */
export async function removeStockFromLocation(
  itemId: string,
  body: RemoveStockBody,
): Promise<void> {
  try {
    await api(`/api/v1/items/${itemId}/remove-stock`, { method: 'POST', body });
  } catch (e) {
    throw new Error(extractApiMessage(e));
  }
}

/**
 * The message to show a person. `api()` already reduces a non-2xx to the
 * server's friendly `message` (and never echoes a raw HTML error page), so this
 * is just the Error → string step.
 */
function extractApiMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
