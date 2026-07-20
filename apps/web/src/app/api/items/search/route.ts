// apps/web/src/app/api/items/search/route.ts
import { NextResponse } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { InventoryService, type ItemListSort } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TYPES = new Set([
  'product',
  'book',
  'asset',
  'consumable',
  'all',
]);
const VALID_STATUSES = new Set([
  'active',
  'archived',
  'discontinued',
  'all',
]);
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

/**
 * Dedicated search endpoint used by the InventoryTable's instant-search
 * client flow. A thin wrapper around InventoryService.list that also
 * batches primary-image signed URLs so the response is drop-in
 * compatible with what the table renders today.
 *
 * Separate from /api/search (the command-palette endpoint) because that
 * one searches across items + POs + suppliers + warehouses and caps at
 * 5 per group. This one is items-only and supports the full filter set
 * the inventory page exposes.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const params = url.searchParams;
  const raw = (params.get('q') ?? '').trim();
  // Browse mode (`?browse=1`): the cycle-count embedded picker needs a
  // paginated default listing BEFORE the user types anything, so it can
  // render a checkable list on open. Only that flag relaxes the 2-char
  // floor — the instant-search flow keeps its guard so a keystroke of
  // "a" never triggers an unfiltered org-wide scan.
  const browse = params.get('browse') === '1';
  if (!browse && raw.length < 2) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const rawType = params.get('type');
  const itemType =
    rawType && VALID_TYPES.has(rawType)
      ? (rawType as 'product' | 'book' | 'asset' | 'consumable' | 'all')
      : undefined;

  const rawStatus = params.get('status');
  const status =
    rawStatus && VALID_STATUSES.has(rawStatus)
      ? (rawStatus as 'active' | 'archived' | 'discontinued' | 'all')
      : undefined;

  const stock = params.get('stock');
  const lowStock = stock === 'low';
  const outOfStock = stock === 'out';

  // Expected-items visibility (mig 0277): mirrors the list pages —
  // '?expected=1' returns ONLY items awaiting their first receipt (the
  // Expected chip view's in-view search); anything else excludes them,
  // which InventoryService.list does by default.
  const expected = params.get('expected') === '1';

  const rawSort = params.get('sort');
  const sort =
    rawSort && VALID_SORTS.has(rawSort as ItemListSort)
      ? (rawSort as ItemListSort)
      : undefined;

  const categoryIds = params.getAll('cat').filter(Boolean);
  const locationIds = params.getAll('loc').filter(Boolean);
  const rack = params.get('rack') ?? undefined;

  // Optional warehouse narrowing (`?wh=<id>`), used by the cycle-count
  // picker's warehouse filter. InventoryService.list treats this as a
  // manager/admin-only convenience filter — warehouse-scoped users are
  // force-narrowed to their assignments regardless of what's passed.
  const warehouseId = params.get('wh') || undefined;

  // Clamp ranges so a hostile caller can't request 1M-row pages or
  // skip to offset 10^9. InventoryService.list also clamps but we
  // catch obvious garbage at the boundary.
  const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
  const offset = Math.min(10_000, Math.max(0, Number(params.get('offset')) || 0));

  const inventorySvc = new InventoryService(ctx);
  const result = await inventorySvc.list({
    q: raw,
    itemType,
    // The Expected view spans lifecycles (mobile's listStatusPredicate
    // lifecycle:null; the Items/Books pages pass status:'all' the same
    // way) — so searching inside the chip view also reaches a flagged
    // item someone manually archived.
    status: expected ? 'all' : status,
    lowStock,
    outOfStock,
    expected,
    sort,
    categoryIds,
    locationIds,
    rack,
    warehouseId,
    limit,
    offset,
  });

  // Attach signed image URLs in batch. Mirrors what page.tsx does for
  // the SSR render so the client-side swap is visually consistent.
  const imagesSvc = new ItemImagesService(ctx);
  const imagesById = await imagesSvc.primaryImagesForItems(
    result.items.map((i) => i.id as string),
  );

  const items = result.items.map((i) => {
    const cf = (i as { custom_fields?: Record<string, unknown> | null })
      .custom_fields;
    const cfThumb =
      cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
        ? (cf.thumbnail_url as string)
        : null;
    return {
      id: i.id as string,
      sku: i.sku as string,
      barcode: (i as { barcode?: string | null }).barcode ?? null,
      name: i.name as string,
      quantity_on_hand: Number(i.quantity_on_hand) || 0,
      reorder_point: Number(i.reorder_point) || 0,
      unit_cost: Number(i.unit_cost) || 0,
      retail_price: Number(i.retail_price) || 0,
      status: i.status as 'active' | 'archived' | 'discontinued',
      // Expected pill (mig 0277) on server-search rows — only ever true
      // inside the ?expected=1 view (the default list excludes flagged).
      awaiting_first_receipt: i.awaiting_first_receipt === true,
      category_id: (i as { category_id?: string | null }).category_id ?? null,
      primary_location_id:
        (i as { primary_location_id?: string | null }).primary_location_id ??
        null,
      warehouse_id: (i as { warehouse_id?: string | null }).warehouse_id ?? null,
      item_type: i.item_type as 'product' | 'book' | 'asset' | 'consumable',
      custom_fields: cf ?? null,
      updated_at: i.updated_at as string,
      image_url:
        imagesById.get(i.id as string) ?? cfThumb ?? null,
    };
  });

  return NextResponse.json({ items, total: result.total });
}
