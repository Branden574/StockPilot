import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
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
 *
 * RATE LIMIT: 120 requests an hour per IP (`public-catalog-thumbnails:ip:<ip>`),
 * checked before the token is looked up, closed on a limiter outage like every
 * other anonymous route. The answers below are cached at the CDN per URL, so a
 * visitor of a real link mostly never reaches this function, while every guess
 * at a token is a new URL that does. A 429 is no-store, so one address's
 * refusal is never served to anyone else. There is deliberately no per-token
 * bucket: anyone holding a link could spend it and blank the photos for every
 * other visitor of that link.
 */
const PER_IP_PER_HOUR = 120;
const ONE_HOUR_MS = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const warehouseId = url.searchParams.get('warehouseId');

  if (!token || !warehouseId) {
    return NextResponse.json({ error: 'token + warehouseId required' }, { status: 400 });
  }

  const rl = await checkRateLimit(
    `public-catalog-thumbnails:ip:${clientIpFromRequest(req)}`,
    PER_IP_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
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
      .eq('public_request_token_hash', sha256Hex(token))
      .maybeSingle();
    if (!org) {
      return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
    }
    organizationId = (org as { id: string }).id;
  }

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
  // Sign the MASTER (sharp) source, not the 200px thumb — the public page
  // renders through next/image, which downscales to the exact card cell, so
  // feeding a large source produces a crisp retina thumbnail. A 200px thumb
  // would upscale ~2.5× in the cell and read blurry.
  const urlMap = await imagesSvc.primaryMasterUrlsForItems(itemIds);

  const urls: Record<string, string> = {};
  for (const [k, v] of urlMap) urls[k] = v;

  return NextResponse.json({ urls }, { headers: { 'Cache-Control': cdnCacheControl } });
}
