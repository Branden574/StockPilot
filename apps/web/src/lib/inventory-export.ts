import 'server-only';

import type { ServiceContext } from '@/server/services/context';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { InventoryService, type ItemListSort } from '@/server/services/inventory';

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
}

export interface BuildExportArgs {
  scope: 'selected' | 'filtered' | 'all';
  itemType: 'product' | 'book' | 'asset' | 'consumable' | 'all';
  ids?: string[]; // required when scope === 'selected'
  filters?: InventoryExportFilters; // used when scope === 'filtered'
}

/** A single export cell — exactly what toCsv()/exceljs/react-pdf accept. */
export type ExportCell = string | number | null | undefined;

export interface InventoryExportResult {
  headers: string[];
  rows: Array<Record<string, ExportCell>>; // keyed by header
  total: number;
  truncated: boolean;
  slug: 'books' | 'inventory';
}

/**
 * Build inventory export rows for any format (csv/xlsx/pdf). FAIL-CLOSED on the
 * id→name lookups: a lookup that throws (disabled module, read error) must NOT
 * 500 the whole export — we just leave that column blank. (This is the bug we're
 * fixing: a thrown lookup currently turns the export into a JSON error file.)
 */
export async function buildInventoryExportRows(
  ctx: ServiceContext,
  args: BuildExportArgs,
): Promise<InventoryExportResult> {
  const inv = new InventoryService(ctx);
  const list = await inv.list({
    itemType: args.itemType,
    limit: ROW_CAP,
    ...(args.scope === 'selected'
      ? { ids: args.ids ?? [], status: 'all' as const }
      : args.scope === 'filtered'
        ? {
            q: args.filters?.q,
            status: args.filters?.status ?? 'active',
            lowStock: args.filters?.stock === 'low',
            outOfStock: args.filters?.stock === 'out',
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

  const rows = list.items.map((i) => {
    const cf = (i.custom_fields ?? {}) as Record<string, unknown>;
    const str = (k: string) => {
      const v = cf[k];
      return v == null ? '' : String(v);
    };
    return {
      name: i.name,
      sku: i.sku,
      barcode: i.barcode ?? '',
      item_type: i.item_type,
      status: i.status,
      quantity_on_hand: i.quantity_on_hand,
      reorder_point: i.reorder_point,
      reorder_quantity: (i as unknown as { reorder_quantity?: number }).reorder_quantity ?? 0,
      unit_cost: i.unit_cost,
      retail_price: i.retail_price,
      category: i.category_id ? (catMap.get(i.category_id) ?? '') : '',
      primary_location: i.primary_location_id ? (locMap.get(i.primary_location_id) ?? '') : '',
      supplier: i.supplier_id ? (supMap.get(i.supplier_id) ?? '') : '',
      warehouse: i.warehouse_id ? (whMap.get(i.warehouse_id) ?? '') : '',
      charter: i.charter_id ? (chMap.get(i.charter_id) ?? '') : '',
      tracking_type: i.tracking_type,
      author: str('author'),
      // For books, ISBN is the barcode — the form labels the same column
      // "ISBN" for books and "Barcode" otherwise, and bulk imports
      // store the ISBN at inventory_items.barcode. The custom_fields
      // keys are legacy fallbacks from older imports.
      isbn:
        i.item_type === 'book'
          ? (i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')
          : '',
      grade: str('book_grade'),
      rack_number: str('book_rack_number'),
      rack_row: str('book_rack_row'),
      crate_color: str('book_crate_color'),
      crate_number: str('book_crate_number'),
      created_at: i.created_at,
      updated_at: i.updated_at,
    };
  });

  return {
    headers: [...INVENTORY_EXPORT_HEADERS],
    rows,
    total: list.total,
    truncated: list.total > rows.length,
    slug: args.itemType === 'book' ? 'books' : 'inventory',
  };
}
