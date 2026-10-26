import { NextResponse, type NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';
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

  // Resolve the token through the links table (mig 0261: the migrated General
  // links carry the legacy org tokens). The signed
  // set is the LINK's eligible catalog, resolved through the same
  // `public_link_eligible_items` predicate as the page and the submit
  // endpoint, so thumbnails can't be used to enumerate items a link
  // doesn't expose.
  // Mig 0330: compare sha256(token) against the hashed at-rest column.
  const { data: linkRow } = await admin
    .from('public_request_links')
    .select('id, organization_id, active, expires_at, available_from, available_until')
    .eq('token_hash', sha256Hex(token))
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

  // Legacy organization token (no links row): the empty map, always. Its page
  // renders an empty catalog (app/r/[token]/page.tsx), and this branch used to
  // sign the cover of every active book of the warehouse with no ordering
  // visibility rule at all (0413, design 5.1), so it answers exactly what its
  // page shows and no cover URL leaks through it.
  if (!link) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }
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
  const organizationId = link.organization_id;

  // Module gate (review finding 2026-07-12): mirror the submit route — the
  // `public_requests` module is optional, so an explicit enabled row is
  // required. Without this, an org that disabled the module kept signing
  // catalog thumbnails for anyone holding an old link. Empty response (not
  // an error) — same shape as every other ineligible branch here.
  const { data: modRow } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', organizationId)
    .eq('module_id', 'public_requests')
    .eq('enabled', true)
    .maybeSingle();
  if (!modRow) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
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

  // Eligible item_ids for this link + warehouse, through the same predicate
  // as the page and the submit (it leaves out an item hidden from ordering).
  const { data: eligibleRows } = await admin.rpc('public_link_eligible_items', {
    p_link_id: link.id,
    p_warehouse_id: warehouseId,
  });
  const itemIds = ((eligibleRows ?? []) as Array<{ item_id: string }>)
    .map((r) => r.item_id)
    .slice(0, 500);
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
  // Sign the MASTER (sharp) source, not the 200px thumb — the public page
  // renders through next/image, which downscales to the exact card cell, so
  // feeding a large source produces a crisp retina thumbnail. A 200px thumb
  // would upscale ~2.5× in the cell and read blurry.
  const urlMap = await imagesSvc.primaryMasterUrlsForItems(itemIds);

  const urls: Record<string, string> = {};
  for (const [k, v] of urlMap) urls[k] = v;

  return NextResponse.json({ urls }, { headers: { 'Cache-Control': cdnCacheControl } });
}
