import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns a map of `itemId → thumbnailUrl` for all orderable items in
 * a warehouse. Powers deferred thumbnail loading on the orders/new v2
 * picker — the page server-renders cards with `null` images so first
 * paint is instant, then this endpoint streams the URLs in.
 *
 * The 5-second cold-load on /dashboard/orders/new came from signing
 * 272 transformed Supabase signed URLs in parallel on the server
 * (each = one HTTPS call to /storage/v1/object/sign). Moving that
 * work behind a client-side fetch means the HTML ships immediately;
 * the images progressively appear once this returns.
 *
 * Once warm (per-URL unstable_cache hits the 25-day TTL on later
 * visits) this is sub-100ms. First call after a deploy is still
 * ~2-3s — but it no longer blocks first paint.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const warehouseId = url.searchParams.get('warehouseId');
  if (!warehouseId) {
    return NextResponse.json(
      { error: 'validation_error', message: 'warehouseId is required' },
      { status: 400 },
    );
  }

  // The rentals checkout catalog reuses this endpoint but needs RENTAL items
  // (the orders picker excludes them). includeRentals=1 drops the is_rental filter.
  const includeRentals = url.searchParams.get('includeRentals') === '1';

  // Item IDs to resolve thumbnails for — same filter the picker uses
  // (active, non-bundle, in this warehouse; non-rental unless includeRentals).
  let itemsQuery = ctx.supabase
    .from('inventory_items')
    .select('id')
    .eq('organization_id', ctx.organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .or('is_bundle.is.null,is_bundle.eq.false')
    .limit(500);
  if (!includeRentals) {
    itemsQuery = itemsQuery.eq('is_rental', false);
  }
  const { data: items } = await itemsQuery;

  const itemIds = ((items ?? []) as Array<{ id: string }>).map((i) => i.id);
  if (itemIds.length === 0) {
    return NextResponse.json({ urls: {} }, { status: 200 });
  }

  const imagesSvc = new ItemImagesService(ctx);
  const urlMap = await imagesSvc.primaryImagesForPdfRendering(itemIds, 200);

  const urls: Record<string, string> = {};
  for (const [itemId, signedUrl] of urlMap) {
    urls[itemId] = signedUrl;
  }

  return NextResponse.json({ urls }, { status: 200 });
}
