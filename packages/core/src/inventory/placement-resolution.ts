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
 * ONE MODULE, TWO QUESTIONS — do not use either as the other:
 *
 *   `resolvePlacement`       WHERE DO I SEND A PICKER, for a surface with ONE
 *                            cell to spend. A split is authoritative here: a
 *                            single rack name would leave stock behind.
 *   `holdingsContradictRack` IS THIS STORED RACK STILL TRUE, for a card with
 *                            room to show the summary AND the holdings. A
 *                            split is NOT a contradiction; using the first as
 *                            the second blanked true rows (see its own doc).
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
 *           STILL LOAD-BEARING AFTER 0336, but for a narrower population than
 *           when it was written. Migration 0336 made the reconciliation DERIVE
 *           a book's rack pair from the live holdings, so a freshly synced BOOK
 *           row now agrees with its holdings and this rule only confirms it.
 *           It still carries: (i) every pre-existing production row that no
 *           future write touches, and (ii) NON-BOOKS, whose `rack_number` pair
 *           no reconciliation reads at all — a Chromebook moved wholly into a
 *           position-less crate keeps its old rack forever, and this rule is
 *           the only thing standing between that value and a picker.
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
import {
  locationNameSitsOnRack,
  rackPositionOfLocationName,
  readBookStorage,
  readItemRack,
} from './book-storage';
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
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE STOCK REFUTE THIS RACK LABEL? — the SUMMARY-CARD question
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resolvePlacement` answers "where do I send a picker", for a surface with ONE
 * cell to spend. A DETAIL CARD is a different question: it has room for the
 * item's stored Rack and Crate summaries AND the live holdings side by side, so
 * it should hide a summary only when that summary is FALSE — never merely
 * because the holdings are more precise.
 *
 * The distinction is not academic. The first cut of the item cards reused
 * `resolution.source === 'holdings'` as the hide-it flag, which folded in the
 * SPLIT arm and so blanked the Rack AND Crate rows of every book split across
 * two racks — rows main had always shown, for stock whose label was perfectly
 * true. It also blanked "Gray #BIN on rack 43-B", where the rack summary is
 * exactly right.
 *
 * So: the rack summary is contradicted when the holdings are KNOWN and NONE of
 * them puts stock on the labelled rack. Everything else stands.
 *
 *   holdings                                    label   → contradicted?
 *   ────────────────────────────────────────────────────────────────────
 *   []                          (unknown)       38-A    no  — absence of evidence
 *   [Gray #BIN (crate)]         the 0335 defect 40-B    YES — stock left that rack
 *   [Gray #BIN on rack 43-B]    positioned      43-B    no  — the crate IS on it
 *   [39-B, 5-A]                 split, on it    39-B    no  — main showed this
 *   [5-A, 2-C]                  split, elsewhere 39-B   YES — no stock on 39-B
 *   [5-A]                       single, moved   39-B    YES — see below
 *
 * That last row is sharper than `resolvePlacement`, deliberately. The resolver
 * lets a SINGLE rack holding fall through on the assumption that it and the
 * label name the same shelf; here we can check instead of assume, and a card
 * that has the holdings in hand should not print a shelf they refute.
 *
 * Never fires on an empty list: a caller that did not fetch holdings keeps the
 * label, which is the same additive promise `resolvePlacement` makes.
 */
export function holdingsContradictRack(
  rackLabel: string | null | undefined,
  holdings: readonly RackHoldingLike[] | null | undefined,
): boolean {
  const label = (rackLabel ?? '').trim();
  if (!label) return false;
  const known = holdings ?? [];
  if (known.length === 0) return false;
  return !known.some((h) => locationNameSitsOnRack(h.name, label));
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
 * The WALK-TO locations the resolution names, as a LIST — stripped of
 * quantities and of every surface's own prose ("Rack ", "Crate ", " ×12").
 * Sorted, so a caller's own ordering never reads as a difference.
 *
 * WHO CALLS THIS, AND WHY A LIST RATHER THAN A LABEL
 *
 * The books SKU-group header (`bookRackNamesFor` in inventory-table.tsx) counts
 * DISTINCT RACKS across the rows it collapses. It used to count distinct
 * LABELS, which is not the same number the moment one row is split: the single
 * string "39-B, 5-A" is one label and two racks, so the header announced
 * "1 rack" directly above a tooltip naming two. Counting needs the names
 * un-joined, which is what this returns and what a formatted label cannot give
 * back without being parsed apart.
 *
 * NOT USED BY THE CROSS-FORMATTER GUARD, and its doc used to claim otherwise.
 * `placement-label.guard.test.ts` reduces each rendered label with its own
 * deliberately dumb string reducer (`namesIn`), because every formatter under
 * test now delegates to `resolvePlacement` — comparing them against a second
 * function that also reads the resolution would be a tautology, which is the
 * exact failure mode that file's header warns about.
 */
export function placementPhysicalNames(res: PlacementResolution): string[] {
  switch (res.source) {
    case 'holdings': {
      // ═══ DISTINCT RACK POSITIONS, ONCE EACH — Hunger Games, 2026-08-17 ═══
      // A holding contributes the RACK it stands at, not its full name: a
      // crate "Blue #0 on rack 38-B" is ON rack 38-B, and a book with 97 loose
      // on "38-B" plus 20 in that crate is on ONE rack, not two. The Rack
      // column used to read "38-B, Blue #0 on rack 38-B" — a leak of the
      // crate's identity into the rack list, and a header count of "2 racks"
      // for one shelf. The crate's identity is the CRATE column's job (the
      // summary carries it). Two DIFFERENT racks stay two entries; a
      // position-less crate ("Blue Shelf") is its own place and stays its own
      // name. See rackPositionOfLocationName.
      const names = new Set<string>();
      for (const h of res.holdings) {
        const at = rackPositionOfLocationName(h.name, h.kind);
        if (at) names.add(at);
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    }
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
