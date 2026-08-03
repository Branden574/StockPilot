/**
 * The RAW row an export is built from, separate from any formatted output
 * (Brief section 18). Every format — CSV, Excel, PDF table, PDF catalog — reads
 * this same shape through the field registry, so a value can never differ
 * between two formats of the same export.
 *
 * Field names are camelCase here on purpose: the legacy flat record
 * (INVENTORY_EXPORT_HEADERS) is snake_case because those strings ARE the CSV
 * headers. Keeping the two shapes visibly different stops a mapping bug from
 * hiding behind identical property names.
 *
 * NO 'server-only': the dialog's live preview renders sample rows of exactly
 * this shape in the browser.
 */

/** A single export cell — exactly what toCsv / exceljs / react-pdf accept. */
export type ExportCell = string | number | null | undefined;

/**
 * The resolved image for one row. Only ever a THUMBNAIL: exports must never
 * carry a 2048px master URL (project memory: public-catalog image pipeline).
 * The brief's sketch of this type also had `originalUrl`; it is deliberately
 * absent, and the omission is documented in the section 31 report.
 */
export interface InventoryExportImage {
  /** Signed (or public legacy) URL of a ~200px image, safe to fetch and embed. */
  thumbnailUrl: string;
}

export interface InventoryExportSourceRow {
  id: string;
  /** inventory_items.item_type — 'book' | 'product' | 'asset' | 'consumable'. */
  itemType: string;
  name: string;
  sku: string;
  barcode: string;
  status: string;
  quantityOnHand: number;
  reorderPoint: number;
  reorderQuantity: number;
  unitCost: number | null;
  retailPrice: number | null;
  /** Resolved names; '' when unset or when the lookup failed closed. */
  category: string;
  primaryLocation: string;
  supplier: string;
  warehouse: string;
  /** Resolved charter name, or 'Generic' when charter_id IS NULL. */
  charter: string;
  trackingType: string;
  author: string;
  /** Books only; '' for every other item type. Always a STRING. */
  isbn: string;
  grade: string;
  rackNumber: string;
  rackRow: string;
  crateColor: string;
  crateNumber: string;
  /** Combined display forms from readBookStorage: '38-A' and 'Blue 12'. */
  rackLabel: string;
  crateLabel: string;
  createdAt: string;
  updatedAt: string;
  /** Null unless the request asked for images. A plain CSV never populates it. */
  image: InventoryExportImage | null;
}
