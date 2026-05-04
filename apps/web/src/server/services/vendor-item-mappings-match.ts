/**
 * Pure SKU-matching logic. Lives outside vendor-item-mappings.ts so that
 * vitest can import it without pulling in the `'server-only'` marker.
 */

export interface MappingRow {
  id: string;
  vendor_id: string;
  item_id: string;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
}

export interface MatchInput {
  vendorItemNumber: string | null;
  vendorProductNumber: string | null;
  auxiliaryNumber: string | null;
}

export type MatchSource =
  | 'vendor_item_number'
  | 'vendor_product_number'
  | 'auxiliary_number';

export interface MatchResult {
  itemId: string;
  source: MatchSource;
}

/**
 * Priority-walks the mapping rows for a given vendor and returns the first
 * matching internal item_id. Case-insensitive exact compare.
 */
export function matchByVendorNumber(
  rows: MappingRow[],
  input: MatchInput,
): MatchResult | null {
  const eq = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

  for (const r of rows) {
    if (eq(r.vendor_item_number, input.vendorItemNumber)) {
      return { itemId: r.item_id, source: 'vendor_item_number' };
    }
  }
  for (const r of rows) {
    if (eq(r.vendor_product_number, input.vendorProductNumber)) {
      return { itemId: r.item_id, source: 'vendor_product_number' };
    }
  }
  for (const r of rows) {
    if (eq(r.auxiliary_number, input.auxiliaryNumber)) {
      return { itemId: r.item_id, source: 'auxiliary_number' };
    }
  }
  return null;
}
