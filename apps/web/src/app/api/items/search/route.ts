// apps/web/src/app/api/items/search/route.ts
import { NextResponse } from 'next/server';

const ITEM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { withApiContext } from '@/lib/auth/api-context';
import { isbnVariants } from '@/lib/books/isbn-variants';
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
 *
 * Also the shared search behind the cycle-count picker (`?browse=1`), the
 * order add-items picker (repeated `?type=`) and the PO line-item picker
 * (`?slim=1&isbn=1&expected=any`, plus `?ids=` for label resolution). Every
 * flag added for one of those is opt-in: with none of them present the
 * request behaves exactly as it always has.
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

  // Resolve-by-id mode (`?ids=<uuid>&ids=<uuid>`). A picker that pages its
  // results server-side still has to render the LABEL of an already-selected
  // row that no longer appears in the current page — an edit-mode PO line
  // pointing at an off-page item would otherwise render blank. This narrows
  // to those exact ids (InventoryService.list's `ids` filter only ever
  // SUBTRACTS from the org/RLS/warehouse-scoped set, so it can't widen
  // visibility) and, like a label lookup must, ignores `q` entirely.
  // UUID-validated before it reaches PostgREST: `ids` is the one param that
  // flows into a raw `.in('id', ...)` list, and the repo's own precedent
  // (PoImportsService.UUID_RE, po-imports.ts:370, guarding the lineage
  // lookup) is to shape-check an id rather than hand an arbitrary string to
  // the filter builder. A malformed value is dropped, not passed through -
  // a label lookup has no reason to accept one.
  const ids = params
    .getAll('ids')
    .filter((v) => ITEM_ID_RE.test(v))
    .slice(0, 100);
  const byIds = ids.length > 0;

  if (!browse && !byIds && raw.length < 2) {
    return NextResponse.json({ items: [], total: 0 });
  }

  // A single `type=` keeps the legacy one-value contract (including 'all').
  // REPEATING it (`type=product&type=asset&type=consumable`) narrows to that
  // SET instead — the order add-items picker needs its "Inventory" tab to span
  // every non-book type the order-creation catalog allows, and splitting the
  // types client-side would make `total` describe a different set than the one
  // being rendered, so Load more would lie.
  const rawTypes = params.getAll('type').filter((t) => VALID_TYPES.has(t));
  const narrowedTypes = rawTypes.filter((t) => t !== 'all') as Array<
    'product' | 'book' | 'asset' | 'consumable'
  >;
  const itemTypes = narrowedTypes.length > 1 ? narrowedTypes : undefined;
  const rawType = rawTypes[0];
  const itemType =
    itemTypes === undefined && rawType
      ? (rawType as 'product' | 'book' | 'asset' | 'consumable' | 'all')
      : undefined;

  // `bundles=exclude` drops kit/bundle SKUs, matching what the order-creation
  // catalog (loadCatalogItems) does. Opt-in: the inventory table still shows
  // bundles, which is the whole point of the flag existing there.
  const excludeBundles = params.get('bundles') === 'exclude';

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
  // Expected chip view's in-view search); '?expected=any' applies NO
  // predicate, which is what the PO item pickers need (re-ordering a SKU
  // that is on order but never received must reuse the existing row rather
  // than invite a duplicate — same rule the PO pages' server-side
  // list({ expected: 'any' }) already follows); anything else excludes
  // them, which InventoryService.list does by default.
  const rawExpected = params.get('expected');
  const expected: boolean | 'any' =
    rawExpected === 'any' ? 'any' : rawExpected === '1';

  // ISBN-10 ⇄ ISBN-13 equivalence (`?isbn=1`). A book is stocked under
  // whichever ISBN form was captured at creation (barcode = ISBN, the same
  // column po-imports-lines.ts matches an imported book line against), so a
  // buyer typing the other form finds nothing without expanding it. Opt-in,
  // and isbnVariants() returns [] for anything that isn't a 10/13-character
  // ISBN, so a normal word query is unaffected either way.
  const wantIsbn = params.get('isbn') === '1';
  const isbnMatches = wantIsbn && raw ? isbnVariants(raw) : [];

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
  const result = await inventorySvc.list(
    byIds
      ? {
          // Label resolution, not search: no q, no chip filters. Lifecycle
          // and expected predicates are both opened up because a line can
          // legitimately point at an item that was archived, or that is
          // still awaiting its first receipt, AFTER it was put on the PO —
          // rendering that line blank is the bug this mode exists to stop.
          ids,
          itemType,
          itemTypes,
          excludeBundles,
          status: 'all',
          expected: 'any',
          warehouseId,
          limit: ids.length,
        }
      : {
          q: raw,
          itemType,
          itemTypes,
          excludeBundles,
          // The Expected view spans lifecycles (mobile's listStatusPredicate
          // lifecycle:null; the Items/Books pages pass status:'all' the same
          // way) — so searching inside the chip view also reaches a flagged
          // item someone manually archived. `expected: 'any'` is NOT that
          // view: it must keep the caller's own status filter (default
          // active-only), or a PO picker would start offering archived rows.
          status: expected === true ? 'all' : status,
          lowStock,
          outOfStock,
          expected,
          ...(isbnMatches.length > 0 ? { isbnVariants: isbnMatches } : {}),
          sort,
          categoryIds,
          locationIds,
          rack,
          warehouseId,
          limit,
          offset,
        },
  );

  // Slim projection (`?slim=1`), for pickers that render a text row and no
  // thumbnail — the PO item picker fires one request per debounced keystroke
  // and has no use for a description, a custom_fields blob, or a batch of
  // signed storage URLs it will never render. Skipping the image batch drops
  // a whole storage round trip per keystroke. Opt-in: without the flag the
  // response is exactly the shape every existing caller reads today.
  if (params.get('slim') === '1') {
    const slim = result.items.map((i) => ({
      id: i.id as string,
      sku: i.sku as string,
      name: i.name as string,
      // Books store their ISBN here (barcode = ISBN), which is what the
      // picker row shows next to the Book marker.
      barcode: (i as { barcode?: string | null }).barcode ?? null,
      item_type: i.item_type as 'product' | 'book' | 'asset' | 'consumable',
      unit_cost: Number(i.unit_cost) || 0,
      // Sports variant identity (0298) — NULL on every item in every
      // non-sports org. Carried so a picked variant keeps its identity.
      group_id: (i as { group_id?: string | null }).group_id ?? null,
      variant_size: (i as { variant_size?: string | null }).variant_size ?? null,
    }));
    return NextResponse.json({ items: slim, total: result.total });
  }

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
      // WHERE THE STOCK IS (item_stock_levels, carrying locations.kind), which
      // InventoryService.list already fetched for its own placement math. The
      // cycle-count picker renders a walk-to label off this row and had no way
      // to tell a crate from a rack without it — so it printed the rack an
      // item's custom_fields still name after a position-less put-away, and
      // disagreed with the very count sheet the picker produces.
      placed_holdings: (i as { placed_holdings?: unknown }).placed_holdings ?? [],
      updated_at: i.updated_at as string,
      image_url:
        imagesById.get(i.id as string) ?? cfThumb ?? null,
    };
  });

  return NextResponse.json({ items, total: result.total });
}
