/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE — which physical location does an item's stock sit in?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every picker-facing surface in this repo answers that question, and until
 * this module existed every one of them answered it in its own hand-written
 * copy: two PDF renderers, a cycle-count sheet, a rental catalog, a count
 * picker, an inventory table, an item detail card, and three native screens.
 * Thirteen copies of one predicate is not a style problem — it is a
 * CORRECTNESS problem with a shipping history:
 *
 *   • 2026-07-23  a writer and a reader disagreed about a rack label's SHAPE
 *                 and items went invisible to their own filter.
 *   • 0335        a put-away into a POSITION-LESS CRATE stopped erasing the
 *                 item's rack keys (erasing them was worse: a PARTIAL put-away
 *                 leaves the rest of the stock on a rack nobody mentioned). The
 *                 keys therefore SURVIVE describing a rack the stock has left,
 *                 and every copy that preferred them over the holdings began
 *                 printing rack 38-A for a Chromebook that is entirely in
 *                 "Blue Shelf". Two fix waves each repaired the copy they were
 *                 told about and missed the siblings.
 *
 * Wrong is worse than blank on a document a picker physically walks the
 * warehouse with. So the precedence lives HERE, once, and the render sites
 * carry no precedence at all — they switch on the RESULT.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRECEDENCE
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   0. HOLDINGS (`item_stock_levels`) when they are known to CONTRADICT a
 *      single label. Two ways that happens, and only these two:
 *
 *        a. SPLIT — stock sits on more than one holding. One label names one
 *           rack while the stock sits on several; a picker walking to just
 *           that one leaves the rest behind.
 *
 *        b. CRATE-ONLY — every known holding is a crate. This is the 0335
 *           hazard above: the item's rack keys are a SUMMARY that a
 *           position-less crate put-away deliberately leaves untouched, so
 *           they can name a rack the stock has entirely left. The holding
 *           names the crate — and, when the crate has a position, its rack too
 *           ("Gray #BIN on rack 43-B", `formatCrateLocationName`) — so
 *           preferring it LOSES NOTHING and gains the truth.
 *
 *      A single RACK holding falls through: the label and the holding name the
 *      same shelf, and the label is the richer render (it carries the book's
 *      crate summary alongside).
 *
 *   1. STRUCTURED rack/crate from `custom_fields` — books read the
 *      `book_rack_*` / `book_crate_*` keys, everything else the neutral
 *      `rack_*` pair.
 *   2. `bin_location`, the free-text label. FRESH since 0335 (the put-away
 *      stamps it and nothing else), which is exactly why it now outranks
 *      nothing and is outranked by nothing above it.
 *   3. the primary location (SITE) name, e.g. "DC4".
 *   4. nothing is known.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY `holdings` AND `kind` ARE BOTH OPTIONAL
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Additively, on purpose. A caller that carries no holdings, or carries them
 * without `locations.kind`, gets the PRE-0335 precedence rather than a guess:
 * `kind === 'crate'` is a positive assertion, and `undefined` is not it. That
 * keeps this function safe to adopt one caller at a time — but it also means
 * ADOPTING IT IS NOT THE SAME AS FIXING THE CALLER. A site that never fetches
 * holdings still prints the stale rack; it just does so through one predicate
 * instead of its own. The fix for such a site is DATA, and the guard test
 * (apps/web/src/lib/placement-label.guard.test.ts) pins which sites carry it.
 */
import { readBookStorage, readItemRack } from './book-storage';
import { formatRackHoldings, type RackHoldingLike } from './rack-holdings';

/** What an item's placement is known FROM — see the precedence above. */
export type PlacementResolution =
  /**
   * The holdings contradict any single label. `reason` records WHICH
   * contradiction so a caller can label the row honestly (the native scan
   * sheet says "Split stock" for one and "In crate" for the other).
   */
  | { source: 'holdings'; reason: 'split' | 'crate'; holdings: readonly RackHoldingLike[] }
  /**
   * The item's own structured rack/crate keys. At least one of the two is
   * non-null — a resolution with both null is never produced.
   */
  | { source: 'structured'; rackLabel: string | null; crateLabel: string | null }
  | { source: 'bin'; binLocation: string }
  | { source: 'site'; siteName: string }
  | { source: 'none' };

export interface PlacementInput {
  /** `inventory_items.item_type` — only 'book' reads the `book_*` key family. */
  itemType: string | null | undefined;
  customFields: Record<string, unknown> | null | undefined;
  /** `inventory_items.bin_location`. Omit when the caller does not select it. */
  binLocation?: string | null;
  /** The item's primary location (SITE) name, e.g. "DC4". */
  siteName?: string | null;
  /**
   * Rack/crate `item_stock_levels` rows for THIS item. Carry `kind` (both
   * `fetchRackHoldingsByItem` and `InventoryService.list` do) or rule 0b
   * cannot fire and a stale rack keeps printing.
   */
  holdings?: readonly RackHoldingLike[];
}

/**
 * True when every known holding is a CRATE — the 0335 hazard.
 *
 * Spelled `=== 'crate'` rather than `!== 'rack'` deliberately: a holding whose
 * `kind` the caller did not carry is `undefined`, and treating "I don't know"
 * as "it's a crate" would suppress a rack label on the strength of missing
 * data. Absence of evidence resolves to the OLD behaviour, never to the new.
 */
function isCrateOnly(holdings: readonly RackHoldingLike[]): boolean {
  return holdings.length > 0 && holdings.every((h) => h.kind === 'crate');
}

/** Reads the structured rack/crate pair for an item of either family. */
function readStructured(
  itemType: string | null | undefined,
  customFields: Record<string, unknown> | null | undefined,
): { rackLabel: string | null; crateLabel: string | null } {
  if (itemType === 'book') {
    const info = readBookStorage(customFields);
    return { rackLabel: info.rackLabel, crateLabel: info.crateLabel };
  }
  // Non-books have no crate SUMMARY: `book_crate_*` are book-scoped keys, so a
  // Chromebook in a crate is recorded ONLY by bin_location and the holding.
  return { rackLabel: readItemRack(customFields).rackLabel, crateLabel: null };
}

/** THE decision. Every picker-facing formatter switches on what this returns. */
export function resolvePlacement(input: PlacementInput): PlacementResolution {
  const holdings = input.holdings ?? [];
  if (holdings.length > 1 || isCrateOnly(holdings)) {
    // formatRackHoldings returns null only for an empty list, which neither
    // branch above admits — but a holding array is caller data, so fall
    // through rather than trusting that invariant across a package boundary.
    if (formatRackHoldings(holdings)) {
      return {
        source: 'holdings',
        reason: holdings.length > 1 ? 'split' : 'crate',
        holdings,
      };
    }
  }

  const { rackLabel, crateLabel } = readStructured(input.itemType, input.customFields);
  if (rackLabel || crateLabel) return { source: 'structured', rackLabel, crateLabel };

  const bin = input.binLocation?.trim();
  if (bin) return { source: 'bin', binLocation: bin };

  const site = input.siteName?.trim();
  if (site) return { source: 'site', siteName: site };

  return { source: 'none' };
}

/**
 * The resolution as ONE line — "38-A ×8 · Blue Shelf ×4", "Rack 39-B · Crate
 * Red 5", "Blue Shelf", "DC4". The render for any surface with a single cell
 * to spend (the cycle-count sheet, the rental catalog card, a list row's
 * secondary line).
 *
 * Surfaces with more than one cell (the pick slip's two-line LOCATION column,
 * the item detail card's separate Rack and Crate rows, the native scan sheet's
 * labelled rows) switch on the resolution themselves instead of parsing this
 * string apart.
 */
export function formatPlacementLabel(res: PlacementResolution): string | null {
  switch (res.source) {
    case 'holdings':
      return formatRackHoldings(res.holdings);
    case 'structured':
      return (
        [
          res.rackLabel ? `Rack ${res.rackLabel}` : null,
          res.crateLabel ? `Crate ${res.crateLabel}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null
      );
    case 'bin':
      return res.binLocation;
    case 'site':
      return res.siteName;
    case 'none':
      return null;
  }
}

/**
 * The WALK-TO location the resolution names, stripped of quantities and of
 * every surface's own prose ("Rack ", "Crate ", " ×12").
 *
 * This is what the cross-formatter guard compares: two surfaces may legitimately
 * render "Rack 38-A" and "38-A" and "38-A ×12", but if one of them names 38-A
 * while another names "Blue Shelf" for the same item, one of them is walking a
 * picker to the wrong aisle. Returns the names sorted, so a formatter's own
 * ordering is not mistaken for a disagreement.
 */
export function placementPhysicalNames(res: PlacementResolution): string[] {
  switch (res.source) {
    case 'holdings':
      return [...res.holdings].map((h) => h.name).sort((a, b) => a.localeCompare(b));
    case 'structured':
      // The crate SUMMARY is not a location — it is a note about which box on
      // the rack. The rack is the thing a picker walks to.
      return res.rackLabel ? [res.rackLabel] : [];
    case 'bin':
      return [res.binLocation];
    case 'site':
      return [res.siteName];
    case 'none':
      return [];
  }
}
