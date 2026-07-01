import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { ItemImagesService } from '@/server/services/item-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public version of /api/orders/catalog-thumbnails.
 *
 * Auth: validated via `?token=<public_request_token>` instead of a
 * logged-in session. The token resolves to an organization, then we
 * confirm the warehouseId belongs to that org and is publicly orderable.
 * On success, returns the same `{ urls: Record<itemId, signedUrl> }` map
 * that the staff endpoint returns, so the public picker can reuse the
 * same deferred-thumbnail pattern without any signed-in credentials.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const warehouseId = url.searchParams.get('warehouseId');

  if (!token || !warehouseId) {
    return NextResponse.json(
      { error: 'token + warehouseId required' },
      { status: 400 },
    );
  }

  // Same response is returned for every visitor of the same
  // (token, warehouseId) pair until item-image or warehouse-publicity state
  // changes. Allow the Vercel CDN to serve it from edge for 60s and serve
  // stale-while-revalidate for another 5 minutes. Anonymous endpoint —
  // no personalization, no auth context — so public-cache is safe.
  const cdnCacheControl = 'public, s-maxage=60, stale-while-revalidate=300';

  const admin = createAdminClient();

  // Resolve org by token.
  const { data: org } = await admin
    .from('organizations')
    .select('id')
    .eq('public_request_token', token)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }
  const organizationId = (org as { id: string }).id;

  // Confirm warehouseId belongs to this org and is publicly orderable.
  const { data: wh } = await admin
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('organization_id', organizationId)
    .eq('is_public_orderable', true)
    .maybeSingle();
  if (!wh) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }

  // Get book item_ids for this warehouse.
  const { data: items } = await admin
    .from('inventory_items')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('item_type', 'book')
    .eq('status', 'active')
    .is('deleted_at', null)
    .limit(500);

  const itemIds = ((items ?? []) as Array<{ id: string }>).map((i) => i.id);
  if (itemIds.length === 0) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }

  // Use ItemImagesService with an admin-level ctx so it can sign URLs.
  const imagesSvc = new ItemImagesService({
    supabase: admin,
    organizationId,
    userId: 'public',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    // No module gating on this public image-signing path; ItemImagesService
    // doesn't call assertModuleEnabled and `inventory` is a core module.
    enabledModules: new Set(),
  });
  const urlMap = await imagesSvc.primaryImagesForDisplay(itemIds, 400);

  const urls: Record<string, string> = {};
  for (const [k, v] of urlMap) urls[k] = v;

  return NextResponse.json({ urls }, { headers: { 'Cache-Control': cdnCacheControl } });
}
