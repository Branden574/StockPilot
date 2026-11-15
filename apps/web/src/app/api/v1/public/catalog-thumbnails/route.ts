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
 *
 * ONLY AN ANSWER IS CACHED. Every "nothing to show" below (no such link, a
 * closed link, the module off, a warehouse that is not public, no eligible
 * item) is the empty map with the CDN header, and each is decided by a read.
 * supabase-js resolves a failed read as `{ data: null, error }`, the same
 * shape as "no row", so each read's error is checked: a read that failed is
 * `unavailable()` (503, no-store, Retry-After), never the empty map, and the
 * CDN keeps nothing built on it. The page's loader
 * (lib/use-catalog-thumbnails) retries a refusal by itself.
 */
const PER_IP_PER_HOUR = 120;
const ONE_HOUR_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A read did not answer: never the empty map, and never kept by the CDN. */
function unavailable(): NextResponse {
  return NextResponse.json(
    { error: 'unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store', 'retry-after': '5' } },
  );
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const warehouseId = url.searchParams.get('warehouseId');

  if (!token || !warehouseId) {
    return NextResponse.json({ error: 'token + warehouseId required' }, { status: 400 });
  }
  // The warehouse id is compared with a uuid column. A value that is not a
  // uuid names no warehouse, and the database refuses the comparison with an
  // error, which below would read as "the warehouse read did not answer" (a
  // 503 with a retry) for a request no retry can ever fix. Refused here, as
  // a bad request, before the bucket and before any read.
  if (!UUID_RE.test(warehouseId)) {
    return NextResponse.json({ error: 'invalid warehouseId' }, { status: 400 });
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

  // Resolve the token through the links table (mig 0261: the migrated General
  // links carry the legacy org tokens). The signed
  // set is the LINK's eligible catalog, resolved through the same
  // `public_link_eligible_items` predicate as the page and the submit
  // endpoint, so thumbnails can't be used to enumerate items a link
  // doesn't expose.
  // Mig 0330: compare sha256(token) against the hashed at-rest column.
  const { data: linkRow, error: linkError } = await admin
    .from('public_request_links')
    .select('id, organization_id, active, expires_at, available_from, available_until')
    .eq('token_hash', sha256Hex(token))
    .maybeSingle();
  if (linkError) return unavailable();
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
  //
  // A module state that could not be read is not "off": the read's error is
  // answered as unavailable (see the note at the top), never as the cached
  // empty map of an organization that switched the module off.
  const { data: modRow, error: modError } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', organizationId)
    .eq('module_id', 'public_requests')
    .eq('enabled', true)
    .maybeSingle();
  if (modError) return unavailable();
  if (!modRow) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }

  // Confirm warehouseId belongs to this org and is publicly orderable.
  const { data: wh, error: whError } = await admin
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('organization_id', organizationId)
    .eq('is_public_orderable', true)
    .maybeSingle();
  if (whError) return unavailable();
  if (!wh) {
    return NextResponse.json({ urls: {} }, { headers: { 'Cache-Control': cdnCacheControl } });
  }

  // Eligible item_ids for this link + warehouse, through the same predicate
  // as the page and the submit (it leaves out an item hidden from ordering).
  const { data: eligibleRows, error: eligibleError } = await admin.rpc(
    'public_link_eligible_items',
    {
      p_link_id: link.id,
      p_warehouse_id: warehouseId,
    },
  );
  if (eligibleError) return unavailable();
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
