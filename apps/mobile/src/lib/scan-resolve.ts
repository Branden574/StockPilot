import {
  formatPlacementLabel,
  partitionPlacementHoldings,
  resolvePlacement,
  type PlacedHoldingLike,
  type RackHoldingLike,
} from '@stockpilot/core';

/**
 * Resolves a scanned barcode/SKU value against the raw candidate rows
 * returned by an `.or(barcode.eq.X,sku.eq.X)` lookup.
 *
 * Under Model B the same SKU can legitimately exist as MULTIPLE placement
 * rows (one per charter/rack) — see 0008_warehouse_charters +
 * 0126_relax_sku_uniqueness_per_location. Grabbing an arbitrary row
 * (`.limit(1)`) silently adjusts the wrong placement's stock. This helper
 * makes the ambiguity explicit instead: the caller renders a picker for the
 * `'multiple'` case and lets the user choose which placement to act on.
 *
 * An EXACT barcode match is treated as unambiguous (a barcode identifies one
 * physical unit/label) and wins over any rows that only matched via SKU —
 * mirrors the same rule in the shared web lookup route
 * (apps/web/src/app/api/v1/items/lookup/route.ts).
 */

/**
 * Strips characters that would break a PostgREST `.or(...)` filter string
 * (`%`, `,`, `(`, `)`) out of a scanned value before it's interpolated into
 * one. Mirrors the same sanitization in the shared web lookup route
 * (apps/web/src/app/api/v1/items/lookup/route.ts) — an unescaped `,` or `()`
 * in a barcode/SKU would otherwise be parsed as extra filter clauses instead
 * of literal characters to match.
 */
export function sanitizeScanCode(code: string): string {
  return code.replace(/[%,()]/g, '');
}

export interface ScanMatchLike {
  id: string;
  barcode: string | null;
}

export type ScanResolution<T extends ScanMatchLike> =
  | { kind: 'not_found' }
  | { kind: 'single'; match: T }
  | { kind: 'multiple'; matches: T[] };

export function resolveScanMatches<T extends ScanMatchLike>(
  rows: readonly T[],
  code: string,
): ScanResolution<T> {
  if (rows.length === 0) return { kind: 'not_found' };

  const barcodeMatches = rows.filter((r) => r.barcode === code);
  const finalRows = barcodeMatches.length > 0 ? barcodeMatches : rows;

  if (finalRows.length === 0) return { kind: 'not_found' };
  if (finalRows.length === 1) return { kind: 'single', match: finalRows[0] };
  return { kind: 'multiple', matches: [...finalRows] };
}

/**
 * The placement picker's words (Ungroup test stage, decision R3-1). Under
 * Model B the matches of one scan share a SKU, one row per charter or rack.
 * After an Ungroup the split record keeps its barcode/ISBN, so a scan of that
 * code can match records with DIFFERENT SKUs; "This SKU" is then wrong, and
 * the screen shows each row's SKU so the records can be told apart.
 */
export const SCAN_PICKER_COPY = {
  sameSku: 'This SKU is stocked in more than one place. Choose which one to adjust.',
  manyRecords: 'This code matches more than one record. Choose which one.',
} as const;

export function scanPickerSubtitle(matches: readonly { sku: string }[]): string {
  const skus = new Set(matches.map((m) => (m.sku ?? '').trim()));
  return skus.size > 1 ? SCAN_PICKER_COPY.manyRecords : SCAN_PICKER_COPY.sameSku;
}

/** The location a picker-read row embeds: its name, kind and type. */
type ScanHoldingLocation = { name: string | null; kind: string | null; type?: string | null };

/** One holding as the picker's read returns it: an item_stock_levels row with
 *  its location embedded (an object, or an array of one). */
export interface ScanHoldingRow {
  item_id: string;
  quantity: number | string | null;
  locations: ScanHoldingLocation | ScanHoldingLocation[] | null;
}

/**
 * The placed holdings of each record, by record id, split the way the
 * placement rule reads them (core partitionPlacementHoldings): `rack`, the
 * rack and crate rows, and `other`, every other placed row (a Site, an area)
 * with its kind AND type, so a record whose stock all sits on a Site is named
 * by the Site rather than the rack its keys still name (B37). Staging and
 * Unplaced rows go to neither. A row whose location has no name is skipped.
 * `kind` is carried: without it the rule cannot tell a crate from a rack.
 */
export function scanHoldingsByItem(rows: readonly ScanHoldingRow[]): {
  rack: Map<string, RackHoldingLike[]>;
  other: Map<string, PlacedHoldingLike[]>;
} {
  const placedByItem = new Map<string, PlacedHoldingLike[]>();
  for (const row of rows) {
    const loc = Array.isArray(row.locations) ? row.locations[0] : row.locations;
    if (!loc?.name) continue;
    const list = placedByItem.get(row.item_id) ?? [];
    list.push({
      name: loc.name,
      quantity: Number(row.quantity) || 0,
      kind: loc.kind ?? null,
      type: loc.type ?? null,
    });
    placedByItem.set(row.item_id, list);
  }
  const rack = new Map<string, RackHoldingLike[]>();
  const other = new Map<string, PlacedHoldingLike[]>();
  for (const [itemId, placed] of placedByItem) {
    const { holdings, otherHoldings } = partitionPlacementHoldings(placed);
    if (holdings.length > 0) rack.set(itemId, holdings);
    if (otherHoldings.length > 0) other.set(itemId, otherHoldings);
  }
  return { rack, other };
}

/**
 * The placement picker's line for one record: where its stock is, by the one
 * placement rule (core resolvePlacement), in the words the web lookup API and
 * the Items list use. It was the record's raw rack text, which named one rack
 * for stock split across two, a rack the stock had left for crated stock, and
 * no rack at all for a book whose rack lives in its rack keys (B26). Null when
 * no place is known. `otherHoldings`, from the same read as `holdings`, lets
 * the rule name the Site when every placed unit sits on one (B37).
 */
export function scanCandidatePlacementLabel(input: {
  itemType: string | null;
  customFields: Record<string, unknown> | null;
  binLocation: string | null;
  holdings: readonly RackHoldingLike[];
  otherHoldings?: readonly PlacedHoldingLike[];
}): string | null {
  return formatPlacementLabel(
    resolvePlacement({
      itemType: input.itemType,
      customFields: input.customFields,
      binLocation: input.binLocation,
      holdings: input.holdings,
      otherHoldings: input.otherHoldings,
    }),
  );
}
