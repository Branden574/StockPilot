/**
 * Sage 50 (US) CSV export mappers — the "Migrate from Sage 50" kit.
 *
 * Sage 50 US (formerly Peachtree) has NO cloud API; its built-in exports
 * (File → Select Import/Export → Export Records, plus report-viewer CSV
 * exports) are the practical migration path. This module maps the three
 * relevant files into StockPilot shapes:
 *
 *   1. Inventory Item List  → item master (name/sku/costs/prices/reorder/UoM)
 *   2. Inventory Valuation  → reliable on-hand quantities (the item-list's
 *      quantity column is transaction-derived and often absent/stale — the
 *      valuation report is the trustworthy stock snapshot)
 *   3. Vendor List          → suppliers
 *
 * Everything here is PURE (no I/O) and forgiving about header variants:
 * Sage 50's export wizard lets users pick/rename columns, and header spelling
 * drifts across product years ("E-mail" vs "Email", "Sales Price 1" vs
 * "Price Level 1"). Matching is case/punctuation-insensitive.
 */

export type Sage50FileKind = 'items' | 'valuation' | 'vendors' | 'unknown';

export interface Sage50Item {
  name: string;
  sku: string;
  barcode: string | null;
  description: string | null;
  unit_cost: number;
  retail_price: number;
  /** Filled from the valuation report when provided; else 0. */
  quantity_on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
  unit_of_measure: string;
  inactive: boolean;
  /** Sage 50 "Preferred Vendor ID" — links to a Sage50Vendor.vendorId. */
  vendorId: string | null;
}

export interface Sage50Vendor {
  vendorId: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
}

export interface Sage50SkippedRow {
  row: number;
  reason: string;
}

/** Lowercase + strip everything but letters/digits: "E-mail 1" → "email1". */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find the index of the first header matching any candidate (candidates are
 * pre-normalized). Returns -1 when absent.
 */
function findCol(header: string[], candidates: string[]): number {
  const normalized = header.map(normalizeHeader);
  for (const c of candidates) {
    const i = normalized.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

/** "$1,234.56" → 1234.56 · "(45.00)" → -45 · junk → 0. */
export function parseSageNumber(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim();
  if (!s) return 0;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/** Sage exports booleans as TRUE/FALSE; tolerate Yes/Y/1/T. */
export function parseSageBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['true', 't', 'yes', 'y', '1'].includes(raw.trim().toLowerCase());
}

const ITEM_ID = ['itemid'];
const ITEM_CLASS = ['itemclass'];
const VENDOR_ID = ['vendorid'];
// Valuation-report value columns (absent from the item-list export).
const VALUATION_MARKERS = ['itemvalue', 'avgcost', 'averagecost', 'pctofinvvalue'];

/**
 * Classify an exported CSV by its headers. The item list and the valuation
 * report BOTH carry "Item ID", so disambiguate on their distinctive columns:
 * the item list has "Item Class"/cost-price columns; the valuation report has
 * value/avg-cost columns and no Item Class.
 */
export function detectSage50Kind(header: string[]): Sage50FileKind {
  const has = (cands: string[]) => findCol(header, cands) !== -1;

  if (has(VENDOR_ID) && !has(ITEM_ID)) return 'vendors';
  if (has(ITEM_ID)) {
    if (has(ITEM_CLASS) || has(['lastunitcost']) || has(['salesprice1', 'pricelevel1'])) {
      return 'items';
    }
    if (has(VALUATION_MARKERS) || has(['qtyonhand', 'quantityonhand'])) return 'valuation';
    return 'items';
  }
  return 'unknown';
}

/** Clamp accounting negatives ("(45.00)" → -45) to 0 — StockPilot stock,
 *  costs, and reorder levels can't open negative. */
function clampNonNegative(n: number): number {
  return n < 0 ? 0 : n;
}

/** Light shape check — junk in Sage's email column becomes null, not a failed row. */
function sanitizeEmail(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Map an Inventory Item List export. Rows with a blank Item ID are skipped.
 * Negative numerics (Sage 50's transaction-derived quantity column routinely
 * goes negative) clamp to 0 — `clampedNegative` counts affected rows so the
 * wizard can disclose it. Text fields are truncated to the import schema's
 * bounds so one over-long description never fails the row.
 */
export function mapSage50Items(
  header: string[],
  rows: string[][],
): { items: Sage50Item[]; skipped: Sage50SkippedRow[]; clampedNegative: number } {
  const col = {
    id: findCol(header, ITEM_ID),
    description: findCol(header, ['itemdescription', 'description']),
    salesDescription: findCol(header, ['descriptionforsales', 'salesdescription']),
    lastUnitCost: findCol(header, ['lastunitcost', 'unitcost', 'cost']),
    salesPrice: findCol(header, ['salesprice1', 'pricelevel1', 'salesprice']),
    uom: findCol(header, ['stockingum', 'stockingunit', 'unitofmeasure', 'um']),
    minStock: findCol(header, ['minimumstock', 'minstock', 'reorderpoint']),
    reorderQty: findCol(header, ['reorderquantity', 'reorderqty']),
    qty: findCol(header, ['qtyonhand', 'quantityonhand']),
    upc: findCol(header, ['upcsku', 'upc', 'barcode']),
    inactive: findCol(header, ['inactive']),
    vendor: findCol(header, ['preferredvendorid', 'vendorid', 'preferredvendor']),
  };

  const items: Sage50Item[] = [];
  const skipped: Sage50SkippedRow[] = [];
  let clampedNegative = 0;

  rows.forEach((r, i) => {
    const rowNum = i + 2; // 1-based + header row, matching the CSV the user sees
    const sku = (col.id !== -1 ? (r[col.id] ?? '') : '').trim();
    if (!sku) {
      skipped.push({ row: rowNum, reason: 'Blank Item ID' });
      return;
    }
    const shortDesc = (col.description !== -1 ? (r[col.description] ?? '') : '').trim();
    const longDesc = (col.salesDescription !== -1 ? (r[col.salesDescription] ?? '') : '').trim();

    const raw = {
      unit_cost: col.lastUnitCost !== -1 ? parseSageNumber(r[col.lastUnitCost]) : 0,
      retail_price: col.salesPrice !== -1 ? parseSageNumber(r[col.salesPrice]) : 0,
      quantity_on_hand: col.qty !== -1 ? parseSageNumber(r[col.qty]) : 0,
      reorder_point: col.minStock !== -1 ? parseSageNumber(r[col.minStock]) : 0,
      reorder_quantity: col.reorderQty !== -1 ? parseSageNumber(r[col.reorderQty]) : 0,
    };
    if (Object.values(raw).some((n) => n < 0)) clampedNegative++;

    items.push({
      sku,
      // Sage's "Item Description" is the display name; fall back to the id.
      name: (shortDesc || sku).slice(0, 200),
      description: longDesc ? longDesc.slice(0, 1000) : null,
      barcode: (col.upc !== -1 ? (r[col.upc] ?? '') : '').trim().slice(0, 128) || null,
      unit_cost: clampNonNegative(raw.unit_cost),
      retail_price: clampNonNegative(raw.retail_price),
      quantity_on_hand: clampNonNegative(raw.quantity_on_hand),
      reorder_point: clampNonNegative(raw.reorder_point),
      reorder_quantity: clampNonNegative(raw.reorder_quantity),
      unit_of_measure: (col.uom !== -1 ? (r[col.uom] ?? '') : '').trim().slice(0, 32) || 'unit',
      inactive: col.inactive !== -1 ? parseSageBool(r[col.inactive]) : false,
      vendorId: (col.vendor !== -1 ? (r[col.vendor] ?? '') : '').trim().slice(0, 64) || null,
    });
  });

  return { items, skipped, clampedNegative };
}

/** Map an Inventory Valuation report export to itemId → { qty, avgCost }. */
export function mapSage50Valuation(
  header: string[],
  rows: string[][],
): Map<string, { qty: number; avgCost: number | null }> {
  const col = {
    id: findCol(header, ITEM_ID),
    qty: findCol(header, ['qtyonhand', 'quantityonhand', 'qty']),
    avgCost: findCol(header, ['avgcost', 'averagecost']),
  };
  const out = new Map<string, { qty: number; avgCost: number | null }>();
  if (col.id === -1) return out;

  for (const r of rows) {
    const id = (r[col.id] ?? '').trim();
    if (!id) continue;
    out.set(id, {
      qty: col.qty !== -1 ? parseSageNumber(r[col.qty]) : 0,
      avgCost: col.avgCost !== -1 ? parseSageNumber(r[col.avgCost]) : null,
    });
  }
  return out;
}

/**
 * Overlay valuation-report quantities onto mapped items (the valuation report
 * is the reliable stock snapshot). Negative quantities clamp to 0 — StockPilot
 * stock can't open negative; the count is corrected post-import via cycle
 * count. Avg cost fills unit_cost only when the item list had none.
 */
export function applySage50Valuation(
  items: Sage50Item[],
  valuation: Map<string, { qty: number; avgCost: number | null }>,
): { matched: number; clampedNegative: number } {
  let matched = 0;
  let clampedNegative = 0;
  for (const item of items) {
    const v = valuation.get(item.sku);
    if (!v) continue;
    matched++;
    if (v.qty < 0) {
      clampedNegative++;
      item.quantity_on_hand = 0;
    } else {
      item.quantity_on_hand = v.qty;
    }
    if (item.unit_cost === 0 && v.avgCost !== null && v.avgCost > 0) {
      item.unit_cost = v.avgCost;
    }
  }
  return { matched, clampedNegative };
}

/** Map a Vendor List export. Rows with a blank Vendor ID are skipped. */
export function mapSage50Vendors(
  header: string[],
  rows: string[][],
): { vendors: Sage50Vendor[]; skipped: Sage50SkippedRow[] } {
  const col = {
    id: findCol(header, VENDOR_ID),
    name: findCol(header, ['vendorname', 'name']),
    contact: findCol(header, ['contact', 'contactname']),
    email: findCol(header, ['email', 'email1']),
    phone: findCol(header, ['telephone1', 'phone1', 'phone', 'telephone']),
  };

  const vendors: Sage50Vendor[] = [];
  const skipped: Sage50SkippedRow[] = [];

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const vendorId = (col.id !== -1 ? (r[col.id] ?? '') : '').trim();
    if (!vendorId) {
      skipped.push({ row: rowNum, reason: 'Blank Vendor ID' });
      return;
    }
    const name = (col.name !== -1 ? (r[col.name] ?? '') : '').trim();
    vendors.push({
      vendorId: vendorId.slice(0, 64),
      // Bounds match createSupplierSchema (the canonical supplier floor):
      // name/contact 120, phone 40; junk emails become null at map time so a
      // bad cell never fails the vendor row server-side.
      name: (name || vendorId).slice(0, 120),
      contactName: (col.contact !== -1 ? (r[col.contact] ?? '') : '').trim().slice(0, 120) || null,
      email: sanitizeEmail(col.email !== -1 ? (r[col.email] ?? '') : ''),
      phone: (col.phone !== -1 ? (r[col.phone] ?? '') : '').trim().slice(0, 40) || null,
    });
  });

  return { vendors, skipped };
}
