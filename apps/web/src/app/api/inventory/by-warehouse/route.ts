import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Picker data must never be served from the route cache — on-hand counts
// and the item set both change as users edit inventory.
export const fetchCache = 'force-no-store';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 50;

/**
 * Paginated, warehouse-scoped item list for order-line pickers.
 *
 * The form pre-fetched up to 500 items at the org level and filtered
 * client-side. Orgs with broader catalogs silently lost visibility past
 * 500. This endpoint replaces that load with a real warehouse-scoped
 * page + thumbnail signed URLs (via `ItemImagesService.primaryImagesForItems`).
 *
 *   GET /api/inventory/by-warehouse
 *     ?warehouseId=<uuid>     (required)
 *     &q=<text>               (optional fuzzy match on name/sku/barcode)
 *     &cursor=<offset>        (optional integer offset; "" / unset = page 1)
 *     &limit=<1..50>          (optional, defaults to 50, capped at 50)
 *
 * `InventoryService.list` is offset-based (no opaque cursor today), so
 * `cursor` here is treated as a parsed integer offset. The next page
 * cursor is `offset + items.length`. We expose it as a string so the
 * client can stay agnostic to the underlying scheme.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const warehouseId = (url.searchParams.get('warehouseId') ?? '').trim();
    if (!warehouseId || !UUID_RE.test(warehouseId)) {
      return NextResponse.json(
        { error: 'invalid_warehouse_id' },
        { status: 400 },
      );
    }

    const q = (url.searchParams.get('q') ?? '').trim();

    // Item-type filter — packing slips at L4L are dominantly books, but the
    // picker still needs to surface assets / consumables / generic products
    // when those go out too. Default to 'all' here; the form drives the tab
    // UI and chooses what to send.
    const rawType = (url.searchParams.get('itemType') ?? 'all').trim();
    const itemType: 'all' | 'product' | 'book' | 'asset' | 'consumable' =
      rawType === 'product' ||
      rawType === 'book' ||
      rawType === 'asset' ||
      rawType === 'consumable'
        ? rawType
        : 'all';

    const rawLimit = Number.parseInt(
      url.searchParams.get('limit') ?? `${DEFAULT_LIMIT}`,
      10,
    );
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const rawCursor = (url.searchParams.get('cursor') ?? '').trim();
    let offset = 0;
    if (rawCursor.length > 0) {
      const parsed = Number.parseInt(rawCursor, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return NextResponse.json({ error: 'invalid_cursor' }, { status: 400 });
      }
      offset = parsed;
    }

    const invSvc = new InventoryService(ctx);
    const list = await invSvc.list({
      warehouseId,
      q: q.length > 0 ? q : undefined,
      status: 'active',
      itemType,
      limit,
      offset,
      sort: 'updated_desc',
    });

    // Single batch round-trip for primary thumbnails. Two queries total:
    // one item_images IN (...) and one createSignedUrls call inside the
    // service.
    const imageMap =
      list.items.length > 0
        ? await new ItemImagesService(ctx).primaryImagesForItems(
            list.items.map((i) => i.id),
          )
        : new Map<string, string>();

    const items = list.items.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      quantityOnHand: Number(i.quantity_on_hand) || 0,
      imageUrl: imageMap.get(i.id) ?? null,
    }));

    const consumed = offset + items.length;
    const nextCursor =
      consumed < list.total && items.length > 0 ? String(consumed) : null;

    return NextResponse.json(
      {
        items,
        nextCursor,
        total: list.total,
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      const status =
        e.code === 'forbidden'
          ? 403
          : e.code === 'not_found'
            ? 404
            : e.code === 'validation_error'
              ? 400
              : 500;
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status },
      );
    }
    void reportError(e, { tag: 'inventory.by-warehouse' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
