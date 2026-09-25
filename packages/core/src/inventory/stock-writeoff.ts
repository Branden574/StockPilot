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
  /**
   * Units in warehouses the caller cannot see (item_holdings_elsewhere, 0371).
   * Named as its own entry so the parts add up to the total: without it a
   * staff member was told "32 units still on hand (20 in Unplaced)" and left
   * to wonder where the other 12 were. Omitted or 0: nothing extra is said.
   */
  hiddenQuantity = 0,
): string {
  const unit = total === 1 ? 'unit' : 'units';
  const parts = holdings.map((h) => `${formatStockQuantity(h.quantity)} in ${h.label}`);
  if (hiddenQuantity > 0) {
    parts.push(`${formatStockQuantity(hiddenQuantity)} in ${ELSEWHERE_ARCHIVE_LABEL}`);
  }
  const where = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return (
    `Cannot archive: ${formatStockQuantity(total)} ${unit} still on hand${where}. ` +
    `Remove or move the stock first, or archive it anyway to write it off.`
  );
}

/** How the archive guard names stock the caller cannot see. */
const ELSEWHERE_ARCHIVE_LABEL = "warehouses you can't see";

// ═══════════════════════════════════════════════════════════════════════════
// STOCK IN OTHER WAREHOUSES (0371)
// ═══════════════════════════════════════════════════════════════════════════
//
// A member below manager sees holdings only in their own warehouses (plus
// locations with no warehouse). The screens that show where an item's stock
// is fold in the totals `item_holdings_elsewhere` reports, and say so in
// these words, on the web and on the phone alike. See holdings-elsewhere.ts.

/**
 * Shown where the stock-in-other-warehouses read FAILED. The visible figures
 * are then a partial view, and a screen must say so rather than print them as
 * if they added up.
 */
export const ELSEWHERE_UNAVAILABLE_NOTE =
  'Could not load stock in other warehouses, so it may not be shown here.';

/**
 * "12 in other warehouses", or with the placed locations counted,
 * "7 in other warehouses (2 locations)". The caller is told how much and how
 * many places, never which place: with one place ("(1 location)") the
 * quantity is that unnamed place's quantity.
 */
export function formatElsewhereNote(quantity: number, locationCount = 0): string {
  const base = `${formatStockQuantity(quantity)} in other warehouses`;
  if (locationCount <= 0) return base;
  return `${base} (${locationCount} location${locationCount === 1 ? '' : 's'})`;
}

/**
 * The empty or partial state of a move/remove source list when part of the
 * item's stock is in warehouses the caller cannot move from. `noneHere` is
 * true when the caller holds none of the item's stock at all.
 */
export function formatElsewhereSourcesNote(
  quantity: number,
  opts: { noneHere: boolean },
): string {
  const q = formatStockQuantity(quantity);
  return opts.noneHere
    ? `This item's stock (${q}) is in warehouses you don't manage.`
    : `The rest of this item's stock (${q}) is in warehouses you don't manage.`;
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
 * The units at a location that the archive guard counted (0371's
 * location_stock_census) but the caller's own read could not name, split by
 * WHY they could not be named, because the two call for different words:
 *
 *   • `ofItemsNotVisible` — the holding is visible but its ITEM is not (a
 *     category- or charter-scoped member, or an item with no warehouse):
 *     "units of items you can't see".
 *   • `inWarehouseNotManaged` — the holding itself is out of the caller's
 *     view: since 0371 a staff member reads holdings only in their own
 *     warehouses, and a locations:manage grant lets them archive a location
 *     in any warehouse. Those items are often ones they CAN read (the item
 *     page tells them "7 in other warehouses"), so "items you can't see"
 *     would contradict the item page: "units in a warehouse you don't
 *     manage".
 */
export interface LocationArchiveHiddenStock {
  ofItemsNotVisible?: number;
  inWarehouseNotManaged?: number;
}

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
  /**
   * The units the caller could not name (0371), by reason; see
   * LocationArchiveHiddenStock. Omitted or all 0: the message is unchanged.
   */
  hidden: LocationArchiveHiddenStock = {},
): string {
  const unit = total === 1 ? 'unit' : 'units';
  const tail =
    ` Move or write off that stock first — archiving anyway leaves it ` +
    `still counted in on hand but attached to a hidden location.`;
  const named = holders.slice(0, MAX_NAMED_HOLDERS);
  const rest = holders.length - named.length;
  const namedParts = named.map((h) => `${formatStockQuantity(h.quantity)} of ${h.name}`);
  const units = (n: number) => `${formatStockQuantity(n)} ${n === 1 ? 'unit' : 'units'}`;
  const ofItems = Math.max(0, hidden.ofItemsNotVisible ?? 0);
  const inWarehouse = Math.max(0, hidden.inWarehouseNotManaged ?? 0);
  const ITEMS_WORDS = "of items you can't see";
  const WAREHOUSE_WORDS = "in a warehouse you don't manage";
  const hiddenParts = [
    ...(ofItems > 0 ? [`${units(ofItems)} ${ITEMS_WORDS}`] : []),
    ...(inWarehouse > 0 ? [`${units(inWarehouse)} ${WAREHOUSE_WORDS}`] : []),
  ];
  if (hiddenParts.length > 0) {
    // Nothing named and one reason for all of it: say it once, in the
    // sentence ("still holds 7 units in a warehouse you don't manage").
    if (holders.length === 0 && hiddenParts.length === 1) {
      const words = ofItems > 0 ? ITEMS_WORDS : WAREHOUSE_WORDS;
      return (
        `Cannot archive: ${locationName} still holds ${formatStockQuantity(total)} ${unit}` +
        ` ${words}.${tail}`
      );
    }
    const parts = [
      ...namedParts,
      ...(rest > 0 ? [`${rest} more`] : []),
      ...hiddenParts.map((p, i) => (i === 0 && holders.length === 0 ? p : `and ${p}`)),
    ];
    return (
      `Cannot archive: ${locationName} still holds ${formatStockQuantity(total)} ${unit}` +
      ` (${parts.join(', ')}).${tail}`
    );
  }
  if (rest > 0) namedParts.push(`and ${rest} more`);
  const itemNoun = holders.length === 1 ? 'item' : 'items';
  const detail = named.length > 0 ? ` (${namedParts.join(', ')})` : '';
  const across = holders.length > 0 ? ` across ${holders.length} ${itemNoun}` : '';
  return (
    `Cannot archive: ${locationName} still holds ${formatStockQuantity(total)} ${unit}` +
    `${across}${detail}.${tail}`
  );
}
