import type { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  storefrontError,
  storefrontJson,
  storefrontRateLimited,
  storefrontUnauthenticated,
} from '@/server/lib/order-storefront-http';
import { OrderStorefrontService } from '@/server/services/order-storefront';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The phone catalog's photos (phone ordering PO-3; plan 3.1):
 * GET /api/v1/orders/catalog/photos?warehouseId=.
 *
 * The same gates, kill switch and warehouse perimeter as the catalog route.
 * The URLs come from the phone's own cached map (loadPhoneThumbMapCached,
 * orders-phone-catalog.ts: the 200 px thumbnail when there is one, else the
 * master, signed in calls of at most 1,000 paths, rebuilt every 4 h, warmed by
 * the prewarm cron), and only the items of the caller's own catalog leave the
 * server.
 *
 * 200 { organizationId, warehouseId, photos: { [itemId]: url }, signedAt,
 *       expiresAt }   (each URL valid until expiresAt, 30 days from signedAt)
 * 401; 403; 404 warehouse_not_available; 429 (retry-after;
 * order-photos:<user>, 30 a minute); 503 turned_off; 500 internal_error when
 * the map could not be built (the phone keeps its glyphs and asks again
 * later). Private, no-store, and names the organization.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return storefrontUnauthenticated();

  const rl = await checkRateLimit(`order-photos:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) return storefrontRateLimited(rl.resetAt, ctx.organizationId);

  try {
    return storefrontJson(
      await new OrderStorefrontService(ctx).photos(req.nextUrl.searchParams.get('warehouseId')),
    );
  } catch (e) {
    return storefrontError(e, ctx.organizationId, 'api.v1.orders.catalog_photos');
  }
}
