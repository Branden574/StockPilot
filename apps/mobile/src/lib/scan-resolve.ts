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
