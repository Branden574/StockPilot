import 'server-only';

import type { ServiceContext } from '@/server/services/context';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { InventoryService, type ItemListSort } from '@/server/services/inventory';
import { formatCharterCell } from '@/lib/charter-display';
import { readBookStorage } from '@/lib/book-storage';

import type { ExportCell, InventoryExportSourceRow } from './exports/source-row';

export const INVENTORY_EXPORT_HEADERS = [
  'name',
  'sku',
  'barcode',
  'item_type',
  'status',
  'quantity_on_hand',
  'reorder_point',
  'reorder_quantity',
  'unit_cost',
  'retail_price',
  'category',
  'primary_location',
  'supplier',
  'warehouse',
  'charter',
  'tracking_type',
  'author',
  'isbn',
  'grade',
  'rack_number',
  'rack_row',
  'crate_color',
  'crate_number',
  'created_at',
  'updated_at',
] as const;

const ROW_CAP = 10_000;

export interface InventoryExportFilters {
  q?: string;
  status?: 'active' | 'archived' | 'discontinued' | 'all';
  stock?: 'low' | 'out' | null;
  sort?: ItemListSort;
  categoryIds?: string[];
  locationIds?: string[];
  charterIds?: string[];
  warehouseId?: string | null;
  /** True when the page's "Expected" chip view (?expected=1, mig 0277) is
   *  active — the filtered export then returns ONLY items awaiting their
   *  first receipt, matching what the user sees. Default (absent/false)
   *  excludes them, exactly like the default list views. */
  expected?: boolean;
}

export interface BuildExportArgs {
  scope: 'selected' | 'filtered' | 'all';
  itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[]; // required when scope === 'selected'
  filters?: InventoryExportFilters; // used when scope === 'filtered'
}

/** A single export cell — exactly what toCsv()/exceljs/react-pdf accept.
 *  Defined in ./exports/source-row (which the browser can import too) and
 *  re-exported here because inventory-export-xlsx.ts has always imported it
 *  from this module. */
export type { ExportCell } from './exports/source-row';

export interface InventoryExportResult {
  headers: string[];
  rows: Array<Record<string, ExportCell>>; // keyed by header
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
}

export interface InventoryExportSourceResult {
  rows: InventoryExportSourceRow[];
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
}

/**
 * Build RAW export rows for any format. FAIL-CLOSED on the id-to-name lookups:
 * a lookup that throws (disabled module, read error) must NOT 500 the whole
 * export — we just leave that column blank.
 *
 * Images are NOT resolved here. A plain CSV must issue zero image queries
 * (Brief section 18), so the caller opts in by calling the export image
 * resolver and attaching the result.
 */
export async function buildInventoryExportSourceRows(
  ctx: ServiceContext,
  args: BuildExportArgs,
): Promise<InventoryExportSourceResult> {
  const inv = new InventoryService(ctx);
  const list = await inv.list({
    itemType: args.itemType,
    limit: ROW_CAP,
    ...(args.scope === 'selected'
      ? // expected:'any' (mig 0277): an explicitly-selected row must export
        // whether or not it is still awaiting its first receipt — the ids
        // narrowing IS the user's filter, so the default flagged-row
        // exclusion would silently drop rows they checked.
        { ids: args.ids ?? [], status: 'all' as const, expected: 'any' as const }
      : args.scope === 'filtered'
        ? {
            q: args.filters?.q,
            // The Expected view spans lifecycles (the pages pass
            // status:'all' to list() when ?expected=1), so its export
            // does too — otherwise an archived flagged row shows in the
            // view but vanishes from its export.
            status: args.filters?.expected ? ('all' as const) : (args.filters?.status ?? 'active'),
            lowStock: args.filters?.stock === 'low',
            outOfStock: args.filters?.stock === 'out',
            expected: args.filters?.expected === true,
            sort: args.filters?.sort ?? 'updated_desc',
            categoryIds: args.filters?.categoryIds ?? [],
            locationIds: args.filters?.locationIds ?? [],
            charterIds: args.filters?.charterIds ?? [],
            warehouseId: args.filters?.warehouseId ?? null,
          }
        : { status: 'active' as const }),
  });

  // FAIL-CLOSED lookups — each independently degrades to an empty map.
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
    try {
      return await p;
    } catch {
      return [];
    }
  };
  const [categories, locations, suppliers, warehouses, charters] = await Promise.all([
    safe(new CategoriesService(ctx).list()),
    safe(new LocationsService(ctx).list()),
    safe(new SuppliersService(ctx).list()),
    safe(new WarehousesService(ctx).list()),
    safe(new ChartersService(ctx).list()),
  ]);
  const catMap = new Map(categories.map((c) => [c.id, c.name]));
  const locMap = new Map(locations.map((l) => [l.id, l.name]));
  const supMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const whMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const chMap = new Map(charters.map((c) => [c.id, c.name]));

  const rows: InventoryExportSourceRow[] = list.items.map((i) => {
    const cf = (i.custom_fields ?? {}) as Record<string, unknown>;
    const str = (k: string) => {
      const v = cf[k];
      return v == null ? '' : String(v);
    };
    // The same reader the books list page uses, so "38-A" and "Blue 12" mean
    // exactly what they mean on screen. Never re-derives or rewrites storage.
    const storage = readBookStorage(cf);
    return {
      id: i.id,
      itemType: i.item_type,
      name: i.name,
      sku: i.sku,
      barcode: i.barcode ?? '',
      status: i.status,
      quantityOnHand: i.quantity_on_hand,
      reorderPoint: i.reorder_point,
      // Both columns are `numeric not null default 0` — never SQL NULL — so
      // read straight through like reorder_point. 0 is a real configured
      // value here, not "unset"; it must print, not blank out.
      reorderQuantity: i.reorder_quantity,
      unitCost: i.unit_cost ?? null,
      retailPrice: i.retail_price ?? null,
      category: i.category_id ? (catMap.get(i.category_id) ?? '') : '',
      primaryLocation: i.primary_location_id ? (locMap.get(i.primary_location_id) ?? '') : '',
      supplier: i.supplier_id ? (supMap.get(i.supplier_id) ?? '') : '',
      warehouse: i.warehouse_id ? (whMap.get(i.warehouse_id) ?? '') : '',
      charter: formatCharterCell(i.charter_id, chMap),
      trackingType: i.tracking_type,
      author: str('author'),
      // For books, ISBN is the barcode — the form labels the same column
      // "ISBN" for books and "Barcode" otherwise, and bulk imports store the
      // ISBN at inventory_items.barcode. The custom_fields keys are legacy
      // fallbacks from older imports.
      isbn:
        i.item_type === 'book'
          ? (i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')
          : '',
      // TRIMMED, for the new builder pipeline (field-registry.ts → CSV/XLSX/
      // PDF field exports + the dialog's live preview). readBookStorage's
      // strOrNull trims and collapses whitespace-only to null on purpose —
      // rackLabel/crateLabel composition below depends on it. The legacy flat
      // CSV does NOT read these; see legacyRawBookFields below.
      grade: storage.grade ?? '',
      rackNumber: storage.rackNumber ?? '',
      rackRow: storage.rackRow ?? '',
      crateColor: storage.crateColor ?? '',
      crateNumber: storage.crateNumber ?? '',
      rackLabel: storage.rackLabel ?? '',
      crateLabel: storage.crateLabel ?? '',
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      image: null,
      // UNTRIMMED, LEGACY-ONLY (Global Constraint 2 / R1). Read with the same
      // local str() the pre-Task-6 flat builder used, not readBookStorage —
      // /api/inventory/export.csv is contractually byte-identical forever, so
      // a stored ' College ' must still export ' College ', not 'College'.
      // Only buildInventoryExportRows's projection below may read this; see
      // this property's doc in source-row.ts.
      legacyRawBookFields: {
        grade: str('book_grade'),
        rackNumber: str('book_rack_number'),
        rackRow: str('book_rack_row'),
        crateColor: str('book_crate_color'),
        crateNumber: str('book_crate_number'),
      },
    };
  });

  return {
    rows,
    total: list.total,
    truncated: list.total > rows.length,
    slug: args.itemType === 'book' ? 'books' : 'inventory',
  };
}

/**
 * The legacy flat 25-column record, keyed by INVENTORY_EXPORT_HEADERS.
 *
 * Kept EXACTLY as it was — /api/inventory/export.csv, its consumers and its
 * bookmarked links depend on these header names and this order. It is now a
 * projection of the source rows so there is one query path and one ISBN /
 * charter rule, not two that can drift.
 */
export async function buildInventoryExportRows(
  ctx: ServiceContext,
  args: BuildExportArgs,
): Promise<InventoryExportResult> {
  const source = await buildInventoryExportSourceRows(ctx, args);
  const rows = source.rows.map((r) => ({
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    item_type: r.itemType,
    status: r.status,
    quantity_on_hand: r.quantityOnHand,
    reorder_point: r.reorderPoint,
    reorder_quantity: r.reorderQuantity,
    unit_cost: r.unitCost,
    retail_price: r.retailPrice,
    category: r.category,
    primary_location: r.primaryLocation,
    supplier: r.supplier,
    warehouse: r.warehouse,
    charter: r.charter,
    tracking_type: r.trackingType,
    author: r.author,
    isbn: r.isbn,
    // R1 (Global Constraint 2, review finding 1): read the UNTRIMMED
    // legacyRawBookFields here, not r.grade/r.rackNumber/etc. — those five
    // are readBookStorage's TRIMMED values for the new builder pipeline
    // (field-registry.ts). This projection is /api/inventory/export.csv's
    // contract and must stay byte-identical to what it emitted before Task
    // 6's refactor, whitespace and all. Do not "helpfully" switch these back
    // to the trimmed fields — that reintroduces the exact regression this
    // comment is guarding against.
    grade: r.legacyRawBookFields.grade,
    rack_number: r.legacyRawBookFields.rackNumber,
    rack_row: r.legacyRawBookFields.rackRow,
    crate_color: r.legacyRawBookFields.crateColor,
    crate_number: r.legacyRawBookFields.crateNumber,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
  return {
    headers: [...INVENTORY_EXPORT_HEADERS],
    rows,
    total: source.total,
    truncated: source.truncated,
    slug: source.slug,
  };
}
