/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NATIVE ITEM SCREEN'S LOCATION CARD — which rows does it show?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rules themselves live in @stockpilot/core (`resolvePlacement`,
 * `holdingsContradictRack`); this module owns only the ROW LIST that
 * app/item/[id].tsx renders from them. It exists as a module rather than an
 * IIFE inside the screen for one reason: the screen cannot be loaded under
 * vitest (it imports native modules at top level), so while this logic lived
 * inline the only tests available were source-text pins — and a source-text pin
 * cannot tell a TRUE row from a hidden one. It pinned the shape that hid them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TWO ALPHABETS — the regression this module was extracted to kill
 * ───────────────────────────────────────────────────────────────────────────
 *
 * A rack is a PAIR (number, row). It reaches a human eye through one spelling
 * and a comparison through another, and they are not the same characters:
 *
 *   DISPLAY    "38 · A"   this screen's separator since 42cacb9b. It is a
 *                         typographic choice; nothing may depend on it.
 *   CANONICAL  "38-A"     what `locations.name` holds, what `parseRackLabel`
 *                         splits (on the LAST DASH), and therefore the only
 *                         spelling `holdingsContradictRack` can match.
 *
 * The screen fed the DISPLAY string into the refutation predicate. "38 · A"
 * carries no dash, so it canonicalised to "38 · a" and could never equal a
 * holding named "38-A" — the predicate answered "contradicted" for essentially
 * every item with a rack or crate holding, and the RACK row disappeared even
 * when the stock was exactly there. A non-book on rack 38-A with its stock on
 * 38-A lost the whole location card; a book correctly in "Gray #BIN on rack
 * 43-B" lost the very row the fix was written to restore.
 *
 * So the compared value is DERIVED FROM THE PAIR, never from what is rendered:
 * `formatRackPosition` recomposes (number, row) through the same
 * `parseRackLabel`/`formatRackLabel` that canonicalises the holding side. The
 * display string and the compared string are computed from the same source and
 * never from each other — change the separator to anything you like and the
 * comparison does not notice.
 *
 * Do NOT "fix" this by making the display separator a dash. What a user sees a
 * rack called is not this bug's business, and the next display change would
 * reintroduce it.
 */
import {
  formatPlacementLabel,
  formatRackPosition,
  getCrateColor,
  holdingsContradictRack,
  resolvePlacement,
  type RackHoldingLike,
} from '@stockpilot/core';

/** One row of the location card, in render order. */
export interface PlacementRow {
  /** The all-caps eyebrow, e.g. 'RACK'. Also the React key — never duplicated. */
  label: string;
  value: string;
  /** A color swatch hex, for the CRATE row only. */
  dot?: string | null;
}

export interface PlacementRowsInput {
  /** `inventory_items.item_type` — only 'book' shows CRATE and GRADE rows. */
  itemType: string | null;
  warehouseName: string | null;
  charterName: string | null;
  /** The primary location (SITE) name, e.g. "DC4". */
  locationName: string | null;
  /**
   * The item's own rack SUMMARY, as the PAIR it is stored as. The screen picks
   * the key family (`book_rack_*` for books, `rack_*` otherwise) before calling
   * — this module never touches custom_fields, so a key-name change cannot
   * silently alter which rows appear.
   */
  rackNumber: string | null;
  rackRow: string | null;
  /**
   * The legacy single free-text rack label (older imports stamped one value
   * before the number/row split). Used ONLY when the pair is empty, exactly as
   * the screen did inline. It is already in the canonical alphabet, so it is
   * safe to canonicalise as a whole label parked in the number field — which is
   * precisely what `formatRackPosition` documents itself as tolerating.
   */
  legacyRackLabel: string | null;
  crateColor: string | null;
  crateNumber: string | null;
  grade: string | null;
  binLocation: string | null;
  /**
   * Rack/crate `item_stock_levels` rows for this item — WHERE THE STOCK IS, as
   * opposed to the summary above, which is what the item REMEMBERS. Must carry
   * `kind` or the crate rule cannot fire.
   */
  holdings: readonly RackHoldingLike[];
}

/**
 * The location card's rows. Empty array means the card does not render at all.
 */
export function buildPlacementRows(input: PlacementRowsInput): PlacementRow[] {
  const isBookView = input.itemType === 'book';
  const rows: PlacementRow[] = [];
  if (input.warehouseName) rows.push({ label: 'WAREHOUSE', value: input.warehouseName });
  if (input.charterName) rows.push({ label: 'CHARTER', value: input.charterName });
  if (input.locationName) rows.push({ label: 'LOCATION', value: input.locationName });

  // WHERE THE STOCK IS vs what the item REMEMBERS. The rack summary below is
  // the custom_fields pair; a put-away into a position-less crate preserves it
  // on purpose (mig 0335), so it can name a rack the stock has entirely left.
  // This screen has no PlacementsBreakdown, so the live holdings get their OWN
  // row — added information, never a replacement for the summary.
  //
  // customFields is deliberately null: the screen has already read the pair
  // (with legacy fallbacks the core reader does not carry), so this call is
  // asked ONLY the holdings question.
  const placement = resolvePlacement({
    itemType: input.itemType,
    customFields: null,
    holdings: input.holdings,
  });
  const holdingsRowShown = placement.source === 'holdings';
  if (holdingsRowShown) {
    rows.push({
      label: placement.reason === 'split' ? 'SPLIT STOCK' : 'IN CRATE',
      value: formatPlacementLabel(placement) ?? '',
    });
  }

  // The rack summary, in both alphabets — see the header. `hasPair` decides
  // which source the two spellings come from, and they always come from the
  // SAME one.
  const hasPair = !!(input.rackNumber || input.rackRow);
  const rackDisplay = hasPair
    ? [input.rackNumber, input.rackRow].filter(Boolean).join(' · ')
    : (input.legacyRackLabel ?? '');
  const rackKey = hasPair
    ? formatRackPosition({ rackNumber: input.rackNumber, rackRow: input.rackRow })
    : formatRackPosition({ rackNumber: input.legacyRackLabel });

  // The RACK row stands down only when the holdings REFUTE it. The first cut
  // suppressed it (and CRATE, and BIN) whenever the holdings were authoritative
  // at all, which swept in every split: a book split across two racks lost
  // every summary row it had on main. A crate summary is refuted by nothing
  // here, so it always renders — same rule as the web card.
  //
  // A pair that canonicalises to nothing (a row with no number) yields an empty
  // rackKey, and an empty label refutes nothing — the row stands, which is the
  // pre-0335 behaviour and the safe direction for malformed data.
  const rackStands = !!rackDisplay && !holdingsContradictRack(rackKey, input.holdings);
  if (rackStands) rows.push({ label: 'RACK', value: rackDisplay });

  if (isBookView && (input.crateColor || input.crateNumber)) {
    // Same presentation as web: "Red 5" + a color swatch (the number identifies
    // the crate; the color is the visual aid).
    const cc = getCrateColor(input.crateColor);
    rows.push({
      label: 'CRATE',
      value: [cc?.label ?? input.crateColor, input.crateNumber].filter(Boolean).join(' '),
      dot: cc?.hex ?? null,
    });
  }
  if (isBookView && input.grade) rows.push({ label: 'GRADE', value: input.grade });

  // bin_location is a separate free-text field — only render it when there's NO
  // structured rack info, to avoid double labelling for the same physical spot.
  // A rack label the HOLDINGS refute no longer counts as structured info
  // (hiding the fresh crate label behind a stale rack was this screen's own
  // half of the 0335 defect), and a holdings row already names the physical
  // place, so bin would only repeat it.
  if (!rackStands && !holdingsRowShown && input.binLocation) {
    rows.push({ label: isBookView ? 'BIN' : 'RACK', value: input.binLocation });
  }
  return rows;
}
