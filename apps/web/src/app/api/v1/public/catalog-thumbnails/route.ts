import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { ItemImagesService } from '@/server/services/item-images';
import { isLinkOpen } from '@/server/services/public-catalog';

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

  // Resolve the token: links-table first (mig 0261 — the migrated General
  // links carry the legacy org tokens), organizations fallback. The signed
  // set is the LINK's eligible catalog, resolved through the same
  // `public_link_eligible_items` predicate as the page and the submit
  // endpoint, so thumbnails can't be used to enumerate items a link
  // doesn't expose.
  const { data: linkRow } = await admin
    .from('public_request_links')
    .select('id, organization_id, active, expires_at, available_from, available_until')
    .eq('token', token)
    .maybeSingle();
  type LinkRow = {
    id: string;
    organization_id: string;
    active: boolean;
    expires_at: string | null;
    available_from: string | null;
    available_until: string | null;
  };
  const link = (linkRow as LinkRow | null) ?? null;

  let organizationId: string;
  if (link) {
    if (
      !isLinkOpen({
        active: link.active,
        expiresAt: link.expires_at,
        availableFrom: link.available_from,
        availableUntil: link.available_until,
      })
    ) {
      return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
    }
    organizationId = link.organization_id;
  } else {
    // Legacy fallback — org token without a links row.
    const { data: org } = await admin
      .from('organizations')
      .select('id')
      .eq('public_request_token', token)
      .maybeSingle();
    if (!org) {
      return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
    }
    organizationId = (org as { id: string }).id;
  }

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

  // Eligible item_ids for this link + warehouse (or the pre-0261 book set
  // on the legacy fallback path).
  let itemIds: string[];
  if (link) {
    const { data: eligibleRows } = await admin.rpc('public_link_eligible_items', {
      p_link_id: link.id,
      p_warehouse_id: warehouseId,
    });
    itemIds = ((eligibleRows ?? []) as Array<{ item_id: string }>)
      .map((r) => r.item_id)
      .slice(0, 500);
  } else {
    const { data: items } = await admin
      .from('inventory_items')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('warehouse_id', warehouseId)
      .eq('item_type', 'book')
      .eq('status', 'active')
      .is('deleted_at', null)
      .limit(500);
    itemIds = ((items ?? []) as Array<{ id: string }>).map((i) => i.id);
  }
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
  const urlMap = await imagesSvc.primaryImagesForPdfRendering(itemIds, 200);

  const urls: Record<string, string> = {};
  for (const [k, v] of urlMap) urls[k] = v;

  return NextResponse.json({ urls }, { headers: { 'Cache-Control': cdnCacheControl } });
}
