import { NextResponse, type NextRequest } from 'next/server';

import { rentalItemsPredicate } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import type { ServiceContext } from '@/server/services/context';
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
 *
 * WHICH ITEMS (one shape per caller):
 *   • default: orderable items (active, non-bundle, NOT rentals), the
 *     orders picker's set. Unchanged, request for request.
 *   • `rentalsOnly=1`: ONLY rental items, exactly the rows the New rental
 *     page lists (/dashboard/rentals/new: active, is_rental, not deleted,
 *     by name, first 500). The rentals form sends this.
 *   • `includeRentals=1`, LEGACY: what the rentals form sent before
 *     rentalsOnly. It only DROPPED the is_rental=false filter, so it read
 *     every orderable item in the warehouse (up to 500) and signed a photo
 *     for each one, to decorate a page that shows a handful of rentals:
 *     the ~5 s wait for rental photos on L4L (2026-09-25). Still answered,
 *     unchanged, so a tab running the previous bundle keeps its photos
 *     until it reloads. Nothing sends it any more.
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

  if (url.searchParams.get('rentalsOnly') === '1') {
    // The New rental page's own item query, repeated filter for filter
    // (pattern #10: a client refetch repeats every filter the server render
    // applied), so this signs photos for the items on that page and no
    // others. Bundles are NOT excluded here because that page does not
    // exclude them either.
    const { data: rentalRows, error: rentalRowsError } = await ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('warehouse_id', warehouseId)
      .eq('status', 'active')
      .eq('is_rental', rentalItemsPredicate.isRental)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(500);
    // A failed read is not "no photos": answer an error so the page's hook
    // retries (lib/use-catalog-thumbnails.ts), instead of keeping an empty
    // map for the session.
    if (rentalRowsError) {
      return NextResponse.json(
        { error: 'internal_error', message: 'Could not load rental item photos.' },
        { status: 500 },
      );
    }
    return signedUrlsFor(
      ctx,
      ((rentalRows ?? []) as Array<{ id: string }>).map((i) => i.id),
    );
  }

  // LEGACY (see the header): includeRentals=1 drops the is_rental filter.
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
  return signedUrlsFor(ctx, itemIds);
}

/** `{ urls: { itemId: signedMasterUrl } }` for `itemIds`. */
async function signedUrlsFor(ctx: ServiceContext, itemIds: string[]): Promise<NextResponse> {
  if (itemIds.length === 0) {
    return NextResponse.json({ urls: {} }, { status: 200 });
  }

  const imagesSvc = new ItemImagesService(ctx);
  // Sign the SHARP master (not the 200px thumb): the orders/rentals cards
  // render through next/image (item-card.tsx), whose optimizer downscales the
  // master to the exact retina cell + AVIF/WebP + 24h edge cache. Feeding the
  // 200px thumb made next/image upscale it (blurry on retina) — same fix as
  // the public catalog. Book covers fall back to custom_fields.thumbnail_url
  // inside primaryMasterUrlsForItems.
  const urlMap = await imagesSvc.primaryMasterUrlsForItems(itemIds);

  const urls: Record<string, string> = {};
  for (const [itemId, signedUrl] of urlMap) {
    urls[itemId] = signedUrl;
  }

  return NextResponse.json({ urls }, { status: 200 });
}
