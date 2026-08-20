/**
 * ON HAND / RESERVED / AVAILABLE — the one definition.
 *
 * ═══ WHY THIS IS A PURE FUNCTION AND NOT A COLUMN ═══
 *
 * `stock_reservations` has been live since migration 0073 and is already read
 * by the orders catalog, the rentals pages and auto-archive. What did not exist
 * was anywhere a human could SEE the three numbers together: the audit found
 * `availableQuantity` in exactly three files, all of which meant "units I can
 * move off this shelf" rather than "units not already promised to an order".
 *
 * Availability is therefore DERIVED, never stored. Two facts already own this
 * truth — `inventory_items.quantity_on_hand` and the open rows in
 * `stock_reservations` — and a third column holding their difference is a
 * second inventory truth that goes stale the moment either moves. Everything
 * that needs the number computes it here.
 */

/** The three numbers a stock figure decomposes into, plus what is wrong. */
export interface StockAvailability {
  /** Units physically owned, across every location including staging/unplaced. */
  onHand: number;
  /** Units promised to open orders (or rentals) and not yet consumed. */
  reserved: number;
  /** What a new order may take. Never negative — see below. */
  available: number;
  /**
   * Reserved EXCEEDS on hand. Not a display quirk: it means more units are
   * promised than exist, so at least one order cannot be filled from stock.
   *
   * CLAMPING `available` AT ZERO WITHOUT REPORTING THIS WOULD HIDE IT. A bare
   * `max(0, onHand - reserved)` renders "0 available", which is
   * indistinguishable from an item that is simply sold out — and sold out is
   * normal while over-reserved is a promise nobody can keep. The two must not
   * look the same, so the shortfall travels alongside the clamped number.
   */
  overReserved: boolean;
  /** How many units short the promises are. 0 unless `overReserved`. */
  shortfall: number;
}

/**
 * Decompose an item's stock position.
 *
 * Negative or non-finite inputs are floored to 0 rather than trusted: on-hand
 * is numeric(14,4) and a reservation sum is a fold over rows, so a bad row
 * should degrade one item's display, not produce a negative "available" that
 * then reads as a credit somewhere downstream.
 */
export function stockAvailability(input: {
  onHand: number;
  reserved: number;
}): StockAvailability {
  const onHand = coerceQty(input.onHand);
  const reserved = coerceQty(input.reserved);
  const raw = onHand.value - reserved.value;
  // ═══ A CORRUPT INPUT IS NOT EVIDENCE OF AN OVER-RESERVATION ═══
  //
  // Flooring a NaN on-hand to 0 makes the number SAFE to render; it does not
  // make it TRUE. Deriving "12 promised against 0 owned" from a value we had to
  // invent would report a broken promise we cannot actually substantiate — and
  // a warning that fires on bad data is a warning people learn to scroll past.
  //
  // `available` still clamps to 0 either way, because refusing to promise stock
  // we cannot verify is the conservative direction. Only the ALARM is withheld.
  const trusted = onHand.ok && reserved.ok;
  const over = trusted && raw < 0;
  return {
    onHand: onHand.value,
    reserved: reserved.value,
    available: Math.max(0, raw),
    overReserved: over,
    shortfall: over ? -raw : 0,
  };
}

/** Floor to a usable quantity, reporting whether the input was usable as given. */
function coerceQty(n: number): { value: number; ok: boolean } {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return { value: 0, ok: false };
  return { value: v, ok: true };
}
