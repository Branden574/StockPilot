// THE ROWS THE ITEMS AND BOOKS TABLES RECEIVE (pure; no 'use client' and no
// 'server-only', because the pages build these and the table unpacks them).
//
// The list loaders and InventoryService.list() select every column a list row
// could need (exports, the item page, the phone), and the pages used to hand
// those rows to the table whole. On a manager's Items or Books page that is
// the FULL view (up to INSTANT_MODE_MAX_ROWS rows, instant mode), so every
// column the table never reads crossed the wire once per row: the audit
// columns, supplier, tracking type, the sports variant identity, the
// description, and above all `custom_fields`, where the ISBN imports keep a
// book's author, publisher and catalogue description (often a kilobyte).
//
// Three steps, each a pure function the pages call:
//   1. toInventoryClientRow: only the columns the table's row type names
//      (INVENTORY_CLIENT_ROW_FIELDS), and only the custom_fields keys the list
//      reads (INVENTORY_CLIENT_CUSTOM_FIELD_KEYS: the rack, crate and grade
//      keys behind the Rack column, the rack filter and the placement rule).
//      inventory-client-payload.size.test.ts keeps both lists equal to what
//      the table reads.
//   2. packInventoryClientRows: the instant dataset travels as one field list
//      plus one value array per row, instead of one object per row that
//      repeats every field name. unpackInventoryClientRows rebuilds the same
//      objects in the table. Rows already unpacked pass through unchanged.
//   3. withoutFlatTrends: a trend that is flat at the row's on hand with no
//      movements is exactly what the table draws when a row has no trend
//      (seriesForRow), so it is left out of the map.
//
// None of this touches what is cached or how it is keyed: the loaders and
// their keys are unchanged, and image URLs are still signed per request
// before these steps run.

/** The row columns the Items and Books tables read, in packing order. */
export const INVENTORY_CLIENT_ROW_FIELDS = [
  'id',
  'sku',
  'barcode',
  'model_number',
  'name',
  'status',
  'quantity_on_hand',
  'reorder_point',
  'unit_cost',
  'category_id',
  'charter_id',
  'primary_location_id',
  'warehouse_id',
  'item_type',
  'auto_archived',
  'awaiting_first_receipt',
  'custom_fields',
  'group_id',
  'variant_size',
  'created_at',
  'updated_at',
  'staged_quantity',
  'unplaced_quantity',
  'placed_quantity',
  'placed_racks',
  'rackHoldingsCount',
  'placed_holdings',
  'elsewhere_quantity',
  'display_group_id',
  'display_group_name',
  'display_group_version',
  'image_url',
  'image_thumb_url',
  'image_lqip',
] as const;

export type InventoryClientRowField = (typeof INVENTORY_CLIENT_ROW_FIELDS)[number];

/**
 * The custom_fields keys the list reads: core's readItemRack (rack_number,
 * rack_row) and readBookStorage (book_rack_number, book_rack_row,
 * book_crate_color, book_crate_number, book_grade), which the Rack and Crate
 * cells, resolvePlacement and the instant rack filter (rowMatchesRack) go
 * through. Every other key stays on the server.
 */
export const INVENTORY_CLIENT_CUSTOM_FIELD_KEYS = [
  'rack_number',
  'rack_row',
  'book_rack_number',
  'book_rack_row',
  'book_crate_color',
  'book_crate_number',
  'book_grade',
] as const;

type CustomFields = Record<string, unknown> | null | undefined;

function slimCustomFields(cf: CustomFields): CustomFields {
  if (cf === null || cf === undefined || typeof cf !== 'object') return cf;
  const out: Record<string, unknown> = {};
  for (const key of INVENTORY_CLIENT_CUSTOM_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cf, key)) out[key] = cf[key];
  }
  return out;
}

/** A row as the table receives it: the read columns the source row carries. */
export type InventoryClientRow<T> = Pick<T, Extract<keyof T, InventoryClientRowField>>;

/**
 * One row, reduced to the columns the table reads. A column the source row
 * does not carry stays absent (elsewhere_quantity is on the live path's rows
 * only), so the result reads exactly like the source for every read column.
 */
export function toInventoryClientRow<T extends object>(row: T): InventoryClientRow<T> {
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of INVENTORY_CLIENT_ROW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(src, field)) continue;
    out[field] =
      field === 'custom_fields' ? slimCustomFields(src[field] as CustomFields) : src[field];
  }
  return out as InventoryClientRow<T>;
}

export function toInventoryClientRows<T extends object>(
  rows: readonly T[],
): InventoryClientRow<T>[] {
  return rows.map(toInventoryClientRow);
}

/* ---- packing ------------------------------------------------------------ */

/**
 * Rows packed for the trip to the browser: the field names once, then each
 * row's values in that order. A value of `undefined` means the row does not
 * carry that field (unpacking leaves it absent). Plain JSON otherwise.
 */
export interface PackedInventoryRows<T = unknown> {
  packed: 'inventory-rows-v1';
  fields: string[];
  values: unknown[][];
  /** Never set: carries the row type through the packed form. */
  readonly __row?: T;
}

export function isPackedInventoryRows<T>(
  value: readonly T[] | PackedInventoryRows<T>,
): value is PackedInventoryRows<T> {
  return !Array.isArray(value) && (value as PackedInventoryRows<T>).packed === 'inventory-rows-v1';
}

/** Packs rows (normally already reduced by toInventoryClientRow). */
export function packInventoryClientRows<T extends object>(
  rows: readonly T[],
): PackedInventoryRows<T> {
  const present = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) present.add(k);
  // The known fields first, in their fixed order; any other key after them,
  // so packing never drops what it was handed.
  const fields: string[] = INVENTORY_CLIENT_ROW_FIELDS.filter((f) => present.has(f));
  for (const k of present) if (!fields.includes(k)) fields.push(k);
  const values = rows.map((r) => {
    const src = r as Record<string, unknown>;
    return fields.map((f) => (Object.prototype.hasOwnProperty.call(src, f) ? src[f] : undefined));
  });
  return { packed: 'inventory-rows-v1', fields, values };
}

/** The rows again, as objects. Rows that were never packed pass through. */
export function unpackInventoryClientRows<T>(rows: readonly T[] | PackedInventoryRows<T>): T[] {
  if (!isPackedInventoryRows(rows)) return rows as T[];
  const { fields, values } = rows;
  return values.map((vals) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i++) {
      const v = vals[i];
      if (v !== undefined) out[fields[i]!] = v;
    }
    return out as T;
  });
}

/* ---- trends ------------------------------------------------------------- */

interface TrendSeries {
  qtySeries: number[];
  moveSeries: number[];
}

/**
 * The trends map without the entries the table would draw the same without:
 * a qty line flat at the row's on hand and a moves line of zeros, which is
 * the table's own fallback for a row with no trend (seriesForRow: a 14-day
 * line at the row's on hand, zero moves). Rows are matched by id; an entry
 * for an id not in `rows`, or for a row whose on hand is below zero, is kept.
 */
export function withoutFlatTrends<V extends TrendSeries>(
  trends: ReadonlyMap<string, V>,
  rows: ReadonlyArray<{ id: string; quantity_on_hand: number }>,
): Map<string, V> {
  const qtyById = new Map(rows.map((r) => [r.id, r.quantity_on_hand]));
  const out = new Map<string, V>();
  for (const [id, t] of trends) {
    const qty = qtyById.get(id);
    const flat =
      qty !== undefined &&
      // A size run's header draws a missing trend at max(0, on hand), so a
      // negative on hand keeps its entry.
      qty >= 0 &&
      t.qtySeries.length === FALLBACK_DAYS &&
      t.moveSeries.length === FALLBACK_DAYS &&
      t.qtySeries.every((q) => q === qty) &&
      t.moveSeries.every((m) => m === 0);
    if (!flat) out.set(id, t);
  }
  return out;
}

/** The length of the table's fallback series (seriesForRow). */
const FALLBACK_DAYS = 14;
