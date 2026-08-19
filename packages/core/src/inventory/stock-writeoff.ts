/**
 * Shared vocabulary for REMOVING STOCK FROM A RACK and for the ARCHIVE
 * STOCK-GUARD — the two halves of the "Andrew archived a book to clear one
 * rack and it vanished from the whole system" fix.
 *
 * WHY THIS LIVES IN packages/core. Web (item-detail rack list + archive dialog)
 * and mobile (item screen rack list + archive sheet) must say the SAME words
 * for the SAME situation. The archive-guard message names a total and where the
 * stock sits; the write-off form names the same holding. Any per-platform copy
 * of this drifts, and "the two surfaces disagreed" is exactly the class of bug
 * this system keeps hitting (see movement-history.ts).
 *
 * WHY 'remove' IS THE WRITE-OFF MOVEMENT TYPE. A rack write-off is stock taken
 * OUT of inventory, not moved between locations — so it is a removal, never a
 * transfer. Of the removal-shaped movement types the schema allows
 * (`remove` / `damage` / `loss`), 'remove' is the neutral "taken out of stock"
 * verb; 'damage' and 'loss' assert a specific CAUSE the operator has not
 * claimed. adjust_stock writes this straight through to stock_movements
 * (movement_type is CHECK-constrained to that set in migration 0002), and
 * InventoryService.mapMovementTypeToAuditEvent maps 'remove' to the
 * `stock.removed` audit event, so the removal reads honestly everywhere.
 */

/** The movement_type used for a location-scoped stock write-off. */
export const RACK_WRITE_OFF_MOVEMENT_TYPE = 'remove' as const;

/**
 * Format a stock quantity for human copy. The column is numeric(14,4), so a
 * whole count arrives as "140.0000"; trim to "140" but keep genuine fractional
 * quantities (a partial unit of a bulk good) intact.
 */
export function formatStockQuantity(quantity: number): string {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return '0';
  // Round to the column's 4-dp precision, then drop trailing zeros/point.
  const fixed = n.toFixed(4);
  return fixed.replace(/\.?0+$/, '');
}

/**
 * The display label for a holding in write-off / guard copy: a rack or crate
 * shows its own name; the two system buckets read as "Staging" / "Unplaced"
 * (mirrors placementBreakdown's labelling so the words match the item detail).
 */
export function formatHoldingLabel(kind: string | null, name: string): string {
  return kind === 'staging' ? 'Staging' : kind === 'unplaced' ? 'Unplaced' : name;
}

/** One holding for the archive-guard message: a label and how much it holds. */
export interface StockHoldingSummary {
  label: string;
  quantity: number;
}

/**
 * The message shown when an archive is refused because the item still holds
 * stock — names the TOTAL and WHERE it sits so the operator knows exactly what
 * to remove or move first, and that they can override deliberately.
 *
 * Example (Andrew's Persepolis record):
 *   "Cannot archive: 181 units still on hand (140 in 100-A, 41 in 38-B).
 *    Remove or move the stock first, or archive it anyway to write it off."
 */
export function formatArchiveStockBlockMessage(
  total: number,
  holdings: readonly StockHoldingSummary[],
): string {
  const unit = total === 1 ? 'unit' : 'units';
  const where =
    holdings.length > 0
      ? ` (${holdings
          .map((h) => `${formatStockQuantity(h.quantity)} in ${h.label}`)
          .join(', ')})`
      : '';
  return (
    `Cannot archive: ${formatStockQuantity(total)} ${unit} still on hand${where}. ` +
    `Remove or move the stock first, or archive it anyway to write it off.`
  );
}

/**
 * The message shown when a BULK archive is refused because one or more of the
 * selected items still hold stock. Naming every location across a 500-item
 * batch is noise, so this names the count of affected items instead; the
 * single-item path uses the detailed message above.
 */
export function formatBulkArchiveStockBlockMessage(itemsWithStock: number): string {
  const noun = itemsWithStock === 1 ? 'item' : 'items';
  const verb = itemsWithStock === 1 ? 'holds' : 'hold';
  return (
    `Cannot archive: ${itemsWithStock} selected ${noun} still ${verb} stock. ` +
    `Remove or move their stock first, or archive anyway to write it off.`
  );
}

/** One item still holding stock inside a location being archived. */
export interface LocationStockHolderSummary {
  name: string;
  quantity: number;
}

/** How many holders the location-archive message names before summarising. */
const MAX_NAMED_HOLDERS = 3;

/**
 * The message shown when archiving a LOCATION is refused because stock is still
 * sitting in it — the twin of formatArchiveStockBlockMessage, and deliberately
 * NOT the same sentence.
 *
 * ═══ WHY THIS IS A SEPARATE BUILDER — rack 100-A, 2026-08-19 ═══
 *
 * Archiving an ITEM preserves quantity_on_hand and hides the item, so "archive
 * it anyway to write it off" is a fair description of the override. Archiving a
 * LOCATION removes nothing whatsoever: the `item_stock_levels` rows pointing at
 * it survive the soft-delete untouched, so every unit keeps counting toward
 * on-hand, valuation and reconciliation while the place it names disappears
 * from every list the warehouse can see.
 *
 * That is exactly the trap this guard exists to close. An operator who finds a
 * rack that should not exist reaches for delete; on 2026-07-23 a test rack
 * 100-A was created at DC4 and 22 units are sitting on it still. Archiving it
 * would have turned a visible phantom into an invisible one, and the item
 * wording would have told them they were writing the stock off while doing it.
 *
 * So this copy says what actually happens, and the override is offered as the
 * deliberate decommission it is rather than as a cleanup.
 *
 * Example (rack 100-A as it stands today):
 *   "Cannot archive: 100-A still holds 22 units across 2 items (12 of Science
 *    Dimensions Earth & Space Science, 10 of Science Dimensions Earth & Space
 *    Science). Move or write off that stock first — archiving anyway leaves it
 *    still counted in on hand but attached to a hidden location."
 */
export function formatLocationArchiveStockBlockMessage(
  locationName: string,
  total: number,
  holders: readonly LocationStockHolderSummary[],
): string {
  const unit = total === 1 ? 'unit' : 'units';
  const itemNoun = holders.length === 1 ? 'item' : 'items';
  const named = holders.slice(0, MAX_NAMED_HOLDERS);
  const rest = holders.length - named.length;
  const detail =
    named.length > 0
      ? ` (${named
          .map((h) => `${formatStockQuantity(h.quantity)} of ${h.name}`)
          .join(', ')}${rest > 0 ? `, and ${rest} more` : ''})`
      : '';
  const across = holders.length > 0 ? ` across ${holders.length} ${itemNoun}` : '';
  return (
    `Cannot archive: ${locationName} still holds ${formatStockQuantity(total)} ${unit}` +
    `${across}${detail}. Move or write off that stock first — archiving anyway leaves it ` +
    `still counted in on hand but attached to a hidden location.`
  );
}
