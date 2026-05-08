import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { csvFilename, toCsv } from '@/lib/csv';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import { CategoriesService } from '@/server/services/categories';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { InventoryService, type ItemListSort } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROW_CAP = 10_000;

const VALID_SORTS = new Set<ItemListSort>([
  'updated_desc',
  'updated_asc',
  'name_asc',
  'name_desc',
  'sku_asc',
  'sku_desc',
  'qty_desc',
  'qty_asc',
  'created_desc',
  'created_asc',
]);

const VALID_STATUS = new Set(['active', 'archived', 'discontinued', 'all']);
const VALID_TYPES = new Set(['product', 'book', 'asset', 'consumable', 'all']);

/**
 * Defensive Excel-formula-injection guard. Cells that begin with =, +, -,
 * or @ are interpreted as formulas by spreadsheet software; prefixing
 * with a single quote makes Excel/Sheets render them as plain text.
 * Applied after toCsv's quoting handles commas/quotes/newlines.
 */
function escapeForSpreadsheet(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (s.length === 0) return s;
  const first = s[0]!;
  if (first === '=' || first === '+' || first === '-' || first === '@') {
    return `'${s}`;
  }
  return s;
}

const HEADERS = [
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

export async function GET(request: Request) {
  try {
    const ctx = await withApiContext(request);
    if (!ctx) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }

    const url = new URL(request.url);
    const params = url.searchParams;

    const scope = params.get('scope') === 'all' ? 'all' : 'filtered';
    const rawType = params.get('type') ?? '';
    const itemType = (
      VALID_TYPES.has(rawType) ? rawType : 'all'
    ) as 'product' | 'book' | 'asset' | 'consumable' | 'all';

    // For scope=all we ignore q/status/stock/sort/cat/loc, but we keep
    // itemType so the books-tab "Export all" doesn't dump products.
    const list = await new InventoryService(ctx).list({
      itemType,
      limit: ROW_CAP,
      ...(scope === 'filtered'
        ? {
            q: params.get('q') ?? undefined,
            status: VALID_STATUS.has(params.get('status') ?? '')
              ? (params.get('status') as 'active' | 'archived' | 'discontinued' | 'all')
              : 'active',
            lowStock: params.get('stock') === 'low',
            outOfStock: params.get('stock') === 'out',
            sort: VALID_SORTS.has(params.get('sort') as ItemListSort)
              ? (params.get('sort') as ItemListSort)
              : 'updated_desc',
            categoryIds: params.getAll('cat').filter(Boolean),
            locationIds: params.getAll('loc').filter(Boolean),
            warehouseId: await getActiveWarehouseFilter(),
          }
        : { status: 'active' as const }),
    });

    // Lookup tables for human-readable id → name.
    const [categories, locations, suppliers, warehouses, charters] = await Promise.all([
      new CategoriesService(ctx).list(),
      new LocationsService(ctx).list(),
      new SuppliersService(ctx).list(),
      new WarehousesService(ctx).list(),
      new ChartersService(ctx).list(),
    ]);

    const catMap = new Map(categories.map((c) => [c.id as string, c.name as string]));
    const locMap = new Map(locations.map((l) => [l.id as string, l.name as string]));
    const supMap = new Map(suppliers.map((s) => [s.id as string, s.name as string]));
    const whMap = new Map(warehouses.map((w) => [w.id as string, w.name as string]));
    const chMap = new Map(charters.map((c) => [c.id as string, c.name as string]));

    const rows = list.items.map((i) => {
      const cf = (i.custom_fields ?? {}) as Record<string, unknown>;
      const str = (k: string) => {
        const v = cf[k];
        return v == null ? '' : String(v);
      };
      return {
        name: escapeForSpreadsheet(i.name),
        sku: escapeForSpreadsheet(i.sku),
        barcode: escapeForSpreadsheet(i.barcode ?? ''),
        item_type: i.item_type,
        status: i.status,
        quantity_on_hand: i.quantity_on_hand,
        reorder_point: i.reorder_point,
        reorder_quantity: (i as unknown as { reorder_quantity?: number }).reorder_quantity ?? 0,
        unit_cost: i.unit_cost,
        retail_price: i.retail_price,
        category: escapeForSpreadsheet(i.category_id ? (catMap.get(i.category_id) ?? '') : ''),
        primary_location: escapeForSpreadsheet(
          i.primary_location_id ? (locMap.get(i.primary_location_id) ?? '') : '',
        ),
        supplier: escapeForSpreadsheet(i.supplier_id ? (supMap.get(i.supplier_id) ?? '') : ''),
        warehouse: escapeForSpreadsheet(i.warehouse_id ? (whMap.get(i.warehouse_id) ?? '') : ''),
        charter: escapeForSpreadsheet(i.charter_id ? (chMap.get(i.charter_id) ?? '') : ''),
        tracking_type: i.tracking_type,
        author: escapeForSpreadsheet(str('author')),
        // For books, ISBN is the barcode — the form labels the same column
        // "ISBN" for books and "Barcode" otherwise, and bulk imports
        // store the ISBN at inventory_items.barcode. The custom_fields
        // keys are legacy fallbacks from older imports.
        isbn: escapeForSpreadsheet(
          i.item_type === 'book'
            ? (i.barcode ?? '') || str('isbn') || str('isbn13') || str('isbn10')
            : '',
        ),
        grade: escapeForSpreadsheet(str('book_grade')),
        rack_number: escapeForSpreadsheet(str('book_rack_number')),
        rack_row: escapeForSpreadsheet(str('book_rack_row')),
        crate_color: escapeForSpreadsheet(str('book_crate_color')),
        crate_number: escapeForSpreadsheet(str('book_crate_number')),
        created_at: i.created_at,
        updated_at: i.updated_at,
      };
    });

    let body = toCsv([...HEADERS], rows);

    // Sentinel row when the cap clipped the result — user can re-export
    // with narrower filters to get the rest.
    if (list.total > rows.length) {
      body += `\n# truncated at ${ROW_CAP} rows of ${list.total}`;
    }

    const slug = itemType === 'book' ? 'books' : 'inventory';
    const suffix = scope === 'all' ? 'all' : 'filtered';
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(slug, suffix)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal error' },
      { status: 500 },
    );
  }
}
