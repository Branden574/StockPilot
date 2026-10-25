import { NextResponse, type NextRequest } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';
import {
  EMPTY_PUBLIC_PHOTO_PAGE,
  parsePublicPhotoPageQuery,
  publicPhotoPageUrl,
  type PublicPhotoPage,
} from '@/components/orders/public-v2/photo-pages';
import { ItemImagesService } from '@/server/services/item-images';
import { isLinkOpen, readPublicPhotoPage } from '@/server/services/public-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The photo pages of a request link's public catalog (/r/<token>).
 *
 * Auth: `?token=<request link token>` instead of a signed-in session. The
 * token resolves to a request link and its organization; the warehouse must
 * belong to that organization and be publicly orderable; the items are the
 * link's, through the same `public_link_eligible_items` predicate as the page
 * and the submit endpoint, so the route cannot be used to list items a link
 * does not offer.
 *
 * One request answers ONE page of the link's eligible items, at most
 * PUBLIC_PHOTO_PAGE_ITEMS (500) in item_id order, with the URL of the next
 * page (components/orders/public-v2/photo-pages.ts): each item's photo (or
 * external cover), its blur placeholder and its public description. So an
 * anonymous request signs at most 500 photos and reads the database at most
 * 14 times. It used to sign a photo for every eligible item (to the catalog's
 * ceiling) on each request (B32, integrator decisions 1 and 3).
 *
 * Only the one URL of a page is answered. Any other query (an extra
 * parameter, another order or spelling, page=0) is a 400 with no-store before
 * anything is read: each would be a CDN cache key of its own, so the work
 * above could be repeated at will (decision 2).
 *
 * The answer is the same for every visitor of the same URL until item-image
 * or warehouse state changes, so the Vercel CDN serves it for 60 s and stale
 * for 5 more minutes. Anonymous, no personalization: a public cache is safe.
 */
const CDN_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

function answer(page: PublicPhotoPage) {
  return NextResponse.json(page, { headers: { 'Cache-Control': CDN_CACHE } });
}

export async function GET(req: NextRequest) {
  // Checks that cost no read come first: a refused URL never reaches the
  // database.
  const query = parsePublicPhotoPageQuery(new URL(req.url).search);
  if (!query) {
    return NextResponse.json(
      { error: 'not a photo page URL' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const { token, warehouseId, page } = query;

  const admin = createAdminClient();

  // Resolve the token through the links table (mig 0261: the migrated
  // General links carry the legacy org tokens). Mig 0330: compare
  // sha256(token) against the hashed at-rest column.
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

  // No links row: either no such token, or a legacy organization token. The
  // page renders an EMPTY catalog for a legacy token (r/[token]/page.tsx, fail
  // closed), so there is nothing of its to sign.
  if (!link) return answer(EMPTY_PUBLIC_PHOTO_PAGE);
  if (
    !isLinkOpen({
      active: link.active,
      expiresAt: link.expires_at,
      availableFrom: link.available_from,
      availableUntil: link.available_until,
    })
  ) {
    return answer(EMPTY_PUBLIC_PHOTO_PAGE);
  }
  const organizationId = link.organization_id;

  // Module gate (review finding 2026-07-12): mirror the submit route — the
  // `public_requests` module is optional, so an explicit enabled row is
  // required. Without this, an org that disabled the module kept signing
  // catalog photos for anyone holding an old link.
  const { data: modRow } = await admin
    .from('organization_modules')
    .select('module_id')
    .eq('organization_id', organizationId)
    .eq('module_id', 'public_requests')
    .eq('enabled', true)
    .maybeSingle();
  if (!modRow) return answer(EMPTY_PUBLIC_PHOTO_PAGE);

  // Confirm warehouseId belongs to this org and is publicly orderable.
  const { data: wh } = await admin
    .from('warehouses')
    .select('id')
    .eq('id', warehouseId)
    .eq('organization_id', organizationId)
    .eq('is_public_orderable', true)
    .maybeSingle();
  if (!wh) return answer(EMPTY_PUBLIC_PHOTO_PAGE);

  // The service signs; an admin-level context so it can (ItemImagesService
  // calls no module gate, and `inventory` is a core module).
  const imagesSvc = new ItemImagesService({
    supabase: admin,
    organizationId,
    userId: 'public',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  });

  // A failed read is not an empty page. An empty map with the CDN header
  // would show no photos to every visitor for a minute and five more stale;
  // a 500 no cache keeps, and the page's hook retries it
  // (lib/use-catalog-thumbnails.ts).
  try {
    // Signs the MASTER (sharp) source, not the 200px thumb — the public page
    // renders through next/image, which downscales to the exact card cell.
    const content = await readPublicPhotoPage(
      admin,
      { id: link.id, organizationId },
      warehouseId,
      page,
      (paths) => imagesSvc.signedUrls(paths),
    );
    return answer({
      urls: content.urls,
      lqip: content.lqip,
      descriptions: content.descriptions,
      next:
        content.nextPage === null ? null : publicPhotoPageUrl(token, warehouseId, content.nextPage),
    });
  } catch (err) {
    void reportError(err, { tag: 'public.catalog_thumbnails.page', organizationId });
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
