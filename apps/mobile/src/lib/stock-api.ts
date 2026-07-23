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
export interface NewRack {
  rackNumber: string;
  rackRow?: string;
  crateColor?: string;
  crateNumber?: string;
}

export interface TransferStockBody {
  fromLocationId: string;
  quantity: number;
  notes?: string;
  /** Existing destination. Provide this OR `newRack`, not both. */
  toLocationId?: string;
  /** Create-and-move destination. Provide this OR `toLocationId`, not both. */
  newRack?: NewRack;
}

/** Move stock. Throws a clean Error (the server's friendly message) on a
 *  non-2xx so the caller can Alert it directly. */
export async function transferStock(itemId: string, body: TransferStockBody): Promise<void> {
  try {
    await api(`/api/v1/items/${itemId}/transfer`, { method: 'POST', body });
  } catch (e) {
    throw new Error(extractApiMessage(e));
  }
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
 * The api() client throws `Error("API 400: {\"error\":...,\"message\":\"...\"}")`.
 * Pull the server's friendly `message` out of that text so an Alert shows
 * "Can't move more than is available" instead of the raw status+JSON blob.
 */
function extractApiMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const brace = raw.indexOf('{');
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(brace)) as { message?: string; error?: string };
      if (parsed.message) return parsed.message;
      if (parsed.error) return parsed.error;
    } catch {
      /* fall through to the raw text */
    }
  }
  return raw;
}
