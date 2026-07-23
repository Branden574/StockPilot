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
