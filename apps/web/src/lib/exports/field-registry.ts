import type { Permission } from '@stockpilot/core';

import type { ExportCell, InventoryExportSourceRow } from './source-row';

/**
 * THE field registry (Brief section 17).
 *
 * One typed list drives: the builder dialog's checkboxes and groups, the
 * server's field validation, CSV headings, Excel headings and cell formats,
 * PDF column labels / alignment / widths, and the value read out of each row.
 * There is no per-format hardcoded column array anywhere downstream.
 *
 * NO 'server-only' and no Supabase / react-pdf imports: the dialog imports this
 * module in the browser and the route imports it on the server, which is the
 * only way "the order you chose is the order you get, in all three formats" can
 * be an assertion instead of a hope.
 */

export type InventoryExportFieldKey =
  // common
  | 'image'
  | 'name'
  | 'sku'
  | 'barcode'
  | 'item_type'
  | 'status'
  | 'quantity_on_hand'
  | 'reorder_point'
  | 'reorder_quantity'
  | 'category'
  | 'primary_location'
  | 'warehouse'
  | 'charter'
  | 'supplier'
  | 'tracking_type'
  // book
  | 'isbn'
  | 'author'
  | 'grade'
  | 'rack'
  | 'crate'
  | 'rack_number'
  | 'rack_row'
  | 'crate_color'
  | 'crate_number'
  // financial
  | 'unit_cost'
  | 'retail_price'
  | 'inventory_value'
  // system
  | 'created_at'
  | 'updated_at';

export type InventoryExportFieldGroup = 'common' | 'book' | 'financial' | 'system';

/** How an Excel cell is typed and formatted. CSV/PDF read it as a hint only. */
export type InventoryExportCellType = 'text' | 'number' | 'currency' | 'date';

export interface InventoryExportField {
  key: InventoryExportFieldKey;
  /** Friendly heading. Never a raw column name. */
  label: string;
  group: InventoryExportFieldGroup;
  /** 'book' = only offered when the export's item type is book (or all). */
  appliesTo: 'all' | 'book';
  csvSupported: boolean;
  xlsxSupported: boolean;
  pdfSupported: boolean;
  defaultForBooks: boolean;
  defaultForItems: boolean;
  /** Relative weight for surplus PDF width. */
  pdfWidth: number;
  /** Hard PDF floor in POINTS — the guard against header collision. */
  pdfMinWidth: number;
  /** Optional PDF ceiling in POINTS. */
  pdfMaxWidth?: number;
  align: 'left' | 'right' | 'center';
  cellType: InventoryExportCellType;
  /** False = an identifier that must never break across lines. Enforced by
   *  pdfMinWidth, since @react-pdf has no no-wrap flag. */
  wrap: boolean;
  /**
   * Permission required to include this field.
   *
   * OWNER DECISION OPEN. No cost-visibility permission exists in this codebase:
   * `unit_cost` and `retail_price` are selected unconditionally by
   * InventoryService.list and rendered unconditionally on the item detail page,
   * and PERMISSIONS has no items:view_cost / financials:* entry of any kind
   * (audit B6). Inventing one here would change who can see costs across the
   * product, which is a product decision, not an export decision. So financial
   * fields carry NO permission today — they are available to items:export
   * holders, exactly as they already are on screen — and this slot exists so
   * that gating them later is a one-line edit the server already enforces.
   */
  permission?: Permission;
  /** Extract this field's value from a raw source row. */
  value: (row: InventoryExportSourceRow) => ExportCell;
}

const money = (v: number | null): number => (typeof v === 'number' ? v : 0);

/**
 * Canonical order. The dialog lists fields in this order inside their group,
 * and a field re-added after being removed lands back in this relative
 * position, so a user's column order never depends on the sequence of clicks
 * that produced it.
 */
export const EXPORT_FIELDS: readonly InventoryExportField[] = [
  {
    key: 'image',
    label: 'Image',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0,
    pdfMinWidth: 26,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.image?.thumbnailUrl ?? '',
  },
  {
    key: 'name',
    label: 'Name',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 3,
    pdfMinWidth: 90,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.name,
  },
  {
    key: 'sku',
    label: 'SKU',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 52,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.sku,
  },
  {
    key: 'barcode',
    label: 'Barcode',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.5,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.barcode,
  },
  {
    key: 'item_type',
    label: 'Item type',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.itemType,
  },
  {
    key: 'status',
    label: 'Status',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.status,
  },
  {
    key: 'quantity_on_hand',
    label: 'On hand',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    // FIX-WAVE (Task 4 review): the reviewer fed this registry's OWN default
    // presets (BOOKS_DEFAULT_FIELD_KEYS, ITEMS_DEFAULT_FIELD_KEYS) through the
    // real fitColumnWidths allocator + header-metrics formula and found "On
    // hand" overflowing its own header box by -2.13pt in BOTH — the exact
    // defect Task 1's fix-wave already found and fixed in BOOKS_PDF_COLUMNS
    // (inventory-pdf-columns.ts), which this floor had regressed. Same
    // derivation:
    //   minWidth = ceil(headerWidth('On hand') + 2*REPORT_CELL_PADDING_PT + 2)
    //            = ceil(40.128 + 6 + 2) = ceil(48.128) = 49
    // matching the 49pt floor inventory-pdf-columns.ts and report-configs.ts
    // already use for this exact label. Permanently guarded by
    // registry-preset-fit.test.ts (../pdf/registry-preset-fit.test.ts).
    pdfWidth: 0.9,
    pdfMinWidth: 49,
    pdfMaxWidth: 70,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.quantityOnHand,
  },
  {
    key: 'reorder_point',
    label: 'Reorder point',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    pdfMaxWidth: 80,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.reorderPoint,
  },
  {
    key: 'reorder_quantity',
    label: 'Reorder quantity',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 66,
    pdfMaxWidth: 88,
    align: 'right',
    cellType: 'number',
    wrap: false,
    value: (r) => r.reorderQuantity,
  },
  {
    key: 'category',
    label: 'Category',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.category,
  },
  {
    key: 'primary_location',
    label: 'Location',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.primaryLocation,
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.warehouse,
  },
  {
    key: 'charter',
    label: 'Charter',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    // KEPT at 1.2, NOT aligned to ITEMS_PDF_COLUMNS's 1.4 (Task 4 review
    // finding 3): widening this weight to 1.4 was the naive fix, but
    // measuring it against this registry's OWN ITEMS_DEFAULT_FIELD_KEYS
    // preset (10 fields: name/sku/barcode/quantity_on_hand/category/
    // primary_location/warehouse/supplier/charter/status) — a more crowded
    // row than ITEMS_PDF_COLUMNS's plain 7-column set — shows why the
    // registry needs the narrower value. At 1.4, charter takes enough extra
    // proportional surplus from its neighbours that `warehouse` (pdfMinWidth
    // 62) gets squeezed down to its own floor and its header ("WAREHOUSE",
    // needs 56.49pt) overflows that floor by a measured -0.49pt — a real,
    // reproducible regression caught by registry-preset-fit.test.ts, not a
    // guess. At 1.2, the same preset gives every column (including
    // `warehouse`, margin 4.65pt) a real positive margin. ITEMS_PDF_COLUMNS's
    // plain 7-column row has enough surplus per column that 1.4 never causes
    // it a problem, which is why that file and this field can legitimately
    // differ. If a future preset change removes fields and frees up surplus,
    // re-derive rather than assuming 1.4 is now safe.
    pdfWidth: 1.2,
    pdfMinWidth: 52,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.charter,
  },
  {
    key: 'supplier',
    label: 'Supplier',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: true,
    pdfWidth: 1.4,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.supplier,
  },
  {
    key: 'tracking_type',
    label: 'Tracking type',
    group: 'common',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.trackingType,
  },
  {
    key: 'isbn',
    label: 'ISBN',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    // Fixed and readable, never truncated (Brief section 11). VALUE-based
    // derivation, not a header-width guess, inherited verbatim from the
    // already-shipped, already-tested BOOKS_PDF_COLUMNS floor
    // (inventory-pdf-columns.ts, Task 1's fix-wave): a plain 13-digit ISBN-13
    // measures only 61.44pt, but inventory_items.barcode has no digit-only
    // guard anywhere a human can type it, so a person typing the ISBN exactly
    // as printed on a book's back cover ("978-1-234-56789-7", the standard
    // 5-group hyphenation, 13 digits + 4 hyphens = 17 chars) saves it
    // verbatim, and this column is wrap:false so an undersized floor
    // truncates instead of shrinking. That value measures 72.76pt at
    // REPORT_BODY_FONT_SIZE_PT (8.5pt Helvetica):
    //   minWidth = ceil(72.76 + 2*REPORT_CELL_PADDING_PT + 2)
    //            = ceil(72.76 + 6 + 2) = ceil(80.76) = 81
    // inventory-pdf-columns.ts's PHASE NOTE says the registry inherits these
    // tuned widths; a naive re-derivation from the header alone (66) would
    // silently reintroduce the truncation Task 1's fix-wave closed. Guarded
    // by the "isbn pdf width" regression test below.
    pdfWidth: 1.6,
    pdfMinWidth: 81,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.isbn,
  },
  {
    key: 'author',
    label: 'Author',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 1.6,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'text',
    wrap: true,
    value: (r) => r.author,
  },
  {
    key: 'grade',
    label: 'Grade',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    // Derived, not guessed (Task 4 review finding 3): registry carried 40,
    // inventory-pdf-columns.ts's BOOKS_PDF_COLUMNS carried 38 for the same
    // GRADE header — an unexplained drift, and Task 2's fix-wave already
    // flagged 38's real margin as thin (1.11pt, eroded from 2.40pt by the
    // isbn-width fix). The real floor, using the same formula as isbn/on-hand:
    //   headerWidth('Grade') = width('GRADE', Helvetica-Bold, 8pt)
    //                            + 5*REPORT_HEADER_LETTER_SPACING_PT
    //                         = 28.888 + 2.0 = 30.888
    //   minWidth = ceil(30.888 + 2*REPORT_CELL_PADDING_PT + 2)
    //            = ceil(30.888 + 6 + 2) = ceil(38.888) = 39
    // 39 clears both existing GRADE columns with a real (>=2pt) margin —
    // 2.11pt in BOOKS_PDF_COLUMNS (up from 1.11pt) and 2.11pt in this
    // registry's own BOOKS_DEFAULT_FIELD_KEYS preset — where 38 or 40 each
    // leave one of the two thinner or, in 40's case, off the shared
    // derivation entirely. inventory-pdf-columns.ts's BOOKS_PDF_COLUMNS.grade
    // is updated to the same 39 so the two files agree. Guarded by
    // registry-preset-fit.test.ts and export-pdf-headers-fit.test.ts.
    pdfWidth: 0.8,
    pdfMinWidth: 39,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.grade,
  },
  {
    key: 'rack',
    label: 'Rack',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0.8,
    pdfMinWidth: 40,
    align: 'left',
    cellType: 'text',
    wrap: false,
    // The combined label readBookStorage already computes for the list page
    // ("38-A"). The raw parts stay available as their own fields.
    value: (r) => r.rackLabel,
  },
  {
    key: 'crate',
    label: 'Crate',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: true,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 44,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateLabel,
  },
  {
    key: 'rack_number',
    label: 'Rack number',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 56,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.rackNumber,
  },
  {
    key: 'rack_row',
    label: 'Rack row',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.8,
    pdfMinWidth: 46,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.rackRow,
  },
  {
    key: 'crate_color',
    label: 'Crate color',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 54,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateColor,
  },
  {
    key: 'crate_number',
    label: 'Crate number',
    group: 'book',
    appliesTo: 'book',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 0.9,
    pdfMinWidth: 60,
    align: 'left',
    cellType: 'text',
    wrap: false,
    value: (r) => r.crateNumber,
  },
  {
    key: 'unit_cost',
    label: 'Unit cost',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 52,
    pdfMaxWidth: 76,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    value: (r) => money(r.unitCost),
  },
  {
    key: 'retail_price',
    label: 'Retail price',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 58,
    pdfMaxWidth: 80,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    value: (r) => money(r.retailPrice),
  },
  {
    key: 'inventory_value',
    label: 'Inventory value',
    group: 'financial',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1,
    pdfMinWidth: 68,
    pdfMaxWidth: 92,
    align: 'right',
    cellType: 'currency',
    wrap: false,
    // Derived, never stored. Unknown cost contributes 0 rather than blanking
    // the row, matching how the valuation report treats a costless item.
    value: (r) => money(r.unitCost) * r.quantityOnHand,
  },
  {
    key: 'created_at',
    label: 'Created date',
    group: 'system',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1.2,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'date',
    wrap: false,
    value: (r) => r.createdAt,
  },
  {
    key: 'updated_at',
    label: 'Updated date',
    group: 'system',
    appliesTo: 'all',
    csvSupported: true,
    xlsxSupported: true,
    pdfSupported: true,
    defaultForBooks: false,
    defaultForItems: false,
    pdfWidth: 1.2,
    pdfMinWidth: 62,
    align: 'left',
    cellType: 'date',
    wrap: false,
    value: (r) => r.updatedAt,
  },
];

const BY_KEY = new Map<string, InventoryExportField>(EXPORT_FIELDS.map((f) => [f.key, f]));

export function getExportField(key: string): InventoryExportField | undefined {
  return BY_KEY.get(key);
}

/** Brief section 8, in the brief's exact order. */
export const BOOKS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'author',
  'grade',
  'quantity_on_hand',
  'category',
  'rack',
  'crate',
  'primary_location',
  'status',
];

/**
 * Brief section 9, in the brief's order, MINUS the image.
 *
 * Section 9 lists "1 Image" but the same section requires items PDF images to
 * default OFF while books covers default ON. Selecting the image field IS what
 * turns images on, so the items default omits it; the canonical order above
 * still puts it first, so a user who enables it gets it in position 1.
 */
export const ITEMS_DEFAULT_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'name',
  'sku',
  'barcode',
  'quantity_on_hand',
  'category',
  'primary_location',
  'warehouse',
  'supplier',
  'charter',
  'status',
];

/** At least one of these must be present, or the file identifies nothing. */
export const IDENTIFYING_FIELD_KEYS: readonly InventoryExportFieldKey[] = [
  'name',
  'sku',
  'isbn',
  'barcode',
];

export function defaultFieldKeysFor(itemType: 'book' | 'other'): InventoryExportFieldKey[] {
  return [...(itemType === 'book' ? BOOKS_DEFAULT_FIELD_KEYS : ITEMS_DEFAULT_FIELD_KEYS)];
}

/**
 * The heading a field shows, per format and item type.
 *
 * Three overrides, all from the brief:
 *   - a book's `name` is its Title (section 8's preset says Title, not Name)
 *   - the image column is "Image URL" in CSV, because CSV carries a URL and
 *     never binary (section 15) — the label must never say "images"
 *   - the image column is "Cover" for books (section 8) and "Image" otherwise
 */
export function fieldHeading(
  field: InventoryExportField,
  opts: { format: 'csv' | 'xlsx' | 'pdf'; itemType: 'book' | 'other' },
): string {
  if (field.key === 'image') {
    if (opts.format === 'csv') return 'Image URL';
    return opts.itemType === 'book' ? 'Cover' : 'Image';
  }
  if (field.key === 'name' && opts.itemType === 'book') return 'Title';
  return field.label;
}
