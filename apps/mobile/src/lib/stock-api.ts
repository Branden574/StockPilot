// Type-only (erased at build), so this stays the one shared declaration of the
// four placement fields instead of a second copy that can drift from the
// server's again.
import type { NewLocationFields } from '@stockpilot/core';

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
 * in the source location's warehouse, under 'stock:transfer' (or
 * 'locations:manage') — the placement path's own resolve-or-create
 * (mint_placement_location, migration 0340; owner decision D1).
 */
/**
 * The inline-created destination — the four fields exactly as the transfer
 * route reads them, which is to say core's `NewLocationFields` and nothing of
 * this file's own invention.
 *
 * ═══ IT USED TO SAY "RACK **XOR** CRATE". THAT WAS WRONG ═══
 *
 * This type declared two mutually exclusive branches (`crateNumber?: never` on
 * the rack side, `rackNumber?: never` on the crate side) and claimed the server
 * refuses a body carrying both. The server does the OPPOSITE: A CRATE SITS ON A
 * RACK, so the rack pair alongside crate fields is that crate's POSITION and
 * both halves are kept — see the header of
 * packages/core/src/inventory/new-location.ts, where the `rack_and_crate`
 * problem was deliberately deleted and marked "do not reintroduce", and the
 * route at apps/web/src/app/api/v1/items/[id]/transfer/route.ts which validates
 * with `newLocationFieldsShape` + `refineNewLocation`.
 *
 * Nothing was broken on the wire, because the sheet already sends both fields
 * (`newLocationFields()` in move-stock-form.ts) through an `as NewRack` cast,
 * and a cast is erased before the request is built. That is precisely what made
 * the drift survive: the only reader who could have caught it was told to look
 * away. The live risk was the NEXT caller — one typing its body against this
 * type would find a positioned crate unexpressible and settle for a
 * position-less "Crate #9", which does not dedupe against "Crate #9 on rack A1"
 * (migration 0270's key) and so mints the duplicate location that the whole
 * shared planner exists to prevent (REPRO A).
 *
 * Kept as a named alias rather than deleted: the sheet imports `NewRack` by
 * name in five places. stock-api.types.test.ts pins it to core's shape in BOTH
 * directions, so re-narrowing it here fails the test rather than the warehouse.
 */
export type NewRack = NewLocationFields;

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
  acknowledgedCrateChanges?: { itemId: string; currentFingerprint: string }[];
  /**
   * The answer to the RACK half of that same confirmation — the same scoped
   * shape, fingerprinted over the RACK pair rather than the crate pair — and,
   * by its PRESENCE ALONE, this client's declaration that it can be asked a
   * rack question at all.
   *
   * ═══ SEND IT ON EVERY REQUEST, EVEN EMPTY ═══
   *
   * The route reads an ABSENT list as "this caller cannot answer", and then
   * succeeds while PRESERVING the recorded rack instead of refusing — reported
   * as `crateSyncRackPreserved`. That fail-safe is exactly right for the shipped
   * OTA, which has no rack channel and could not answer a refusal it has no way
   * to render. It is exactly WRONG for a sheet that can ask: omitting the key
   * would take the fail-safe path on every single move, so the operator would
   * never be offered the choice and every rack-clearing put-away would leave a
   * label nobody agreed to keep.
   *
   * `[]` and absent are therefore DIFFERENT MESSAGES, not two spellings of
   * "nothing acknowledged". Empty on the first request is the correct and only
   * honest opening: this sheet holds no live holdings, so it can never predict
   * an erasure — it can only be told of one and then echo it back.
   */
  acknowledgedRackChanges?: { itemId: string; currentFingerprint: string }[];
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
  /**
   * The stock moved and the crate label followed it, but the RACK label was
   * deliberately LEFT AS IT WAS rather than erased, because nobody was shown
   * the erasure — an acknowledgement that did not cover it, or a rack outcome
   * the gate could not predict in time to ask about.
   *
   * The label may now name a rack this stock has left, so the sheet MUST say
   * so. Keeping a stale label is only the safer choice because it is
   * recoverable, and it is recoverable only if somebody hears about it; a
   * preserved rack reported as a bare success is the same silence as an erased
   * one, minus the audit row.
   */
  crateSyncRackPreserved?: boolean;
  /**
   * Its twin for the CRATE label (Maus I, 2026-08-17). The destination is a
   * plain rack, the book records a crate, and this body carried no
   * acknowledgement of that crate being CLEARED — so the server KEPT the label
   * instead of erasing it. Most crates in the warehouse are label-only (no
   * location row), so the label is the crate. The sheet must say it may now be
   * stale.
   */
  crateSyncCratePreserved?: boolean;
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
 * What the write-off route reports back about the book's crate LABEL. The stock
 * left in every case; these say whether the summary followed it.
 *
 * The first four are the SAME four the transfer route answers with, for the
 * same reasons (see TransferStockResult). The fifth has no transfer twin: a
 * write-off can leave the book with exactly one placed holding that is a
 * DIFFERENT crate, and the reconciliation then rewrites a label a human typed.
 * That is a write the operator did not ask for, so it is reported too.
 */
export interface RemoveStockResult {
  crateSyncFailed?: boolean;
  crateSyncSkipped?: boolean;
  crateSyncStale?: boolean;
  crateSyncUnplaced?: boolean;
  /** The summary was rewritten AND its value actually changed — proved by the
   *  service with a before/after fingerprint, never inferred from "it wrote". */
  crateSyncUpdated?: boolean;
  /**
   * The crate half followed the stock, but the RACK label was kept rather than
   * erased. A write-off has no destination and therefore no confirmation gate,
   * so a rack erasure can never be agreed to on this path — draining one of two
   * holdings can leave the book in a single POSITION-LESS crate, which would
   * clear a rack a human typed, and the reconciliation always withholds that.
   * Correct, and worth saying: the label may now name a rack this stock has left.
   */
  crateSyncRackPreserved?: boolean;
  /**
   * The CRATE label was kept rather than cleared: draining the crate holding
   * left the book on a plain rack, and a write-off has no gate to ask about
   * clearing the crate (Maus I, 2026-08-17). It may now be stale.
   */
  crateSyncCratePreserved?: boolean;
}

/**
 * Remove (write off) stock from ONE rack — native parity for the web
 * RemoveFromRackDialog. POSTs to /api/v1/items/<id>/remove-stock, which routes
 * through InventoryService.removeStockFromLocation → adjustStock so the
 * 'stock:adjust' PERMISSION is enforced server-side (the raw adjust_stock RPC
 * only checks the staff-role floor). Leaves stock in every OTHER location
 * untouched — unlike archive, which would hide the whole item and orphan it.
 *
 * RETURNS THE BODY. This used to declare `Promise<void>` and drop it on the
 * floor, which type-erased the crate-sync flags the route answers with — so a
 * write-off from the phone could rewrite a book's crate label, or leave one
 * naming an empty crate, and say nothing at all. Web says so on every one of
 * these outcomes; the phone must too.
 *
 * Throws a clean Error (the server's friendly message) on a non-2xx. Unlike
 * transferStock there is nothing to RE-ASK here — the write-off has no
 * confirmation gate — so flattening the ApiError to its message loses nothing.
 */
export async function removeStockFromLocation(
  itemId: string,
  body: RemoveStockBody,
): Promise<RemoveStockResult> {
  try {
    return ((await api(`/api/v1/items/${itemId}/remove-stock`, {
      method: 'POST',
      body,
    })) ?? {}) as RemoveStockResult;
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
