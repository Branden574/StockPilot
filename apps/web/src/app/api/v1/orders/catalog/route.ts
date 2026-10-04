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
 * The phone's catalog of one warehouse (phone ordering PO-3; plan 3.1), on
 * open and on a warehouse change: GET /api/v1/orders/catalog?warehouseId=.
 *
 * Gates first (the Orders module, the MFA step-up, orders:request), then the
 * kill switch (503 unavailable, details.reason 'turned_off'), then the
 * warehouse perimeter: the id must be one of the caller's non-archived
 * warehouses, read with their own client, or the answer is 404 not_found
 * (details.reason 'warehouse_not_available') before any shared read runs. A
 * missing id is 400 validation_error (details.reason 'invalid').
 *
 * 200 { organizationId, warehouseId, generatedAt, staleAfterSeconds: 60,
 *       rowCeiling: 10000, truncated,
 *       items: [{ id, sku, name, categoryId, charterId, rackLabel,
 *                 quantityOnHand, reservedQuantity, reorderPoint }],
 *       aisles: [{ id | null, name, itemCount }],
 *       charters: { [charterId]: { name, code } },
 *       sites: { status: 'ok', sites } | { status: 'error' },
 *       kits: { status: 'ok', kits } | { status: 'error' },
 *       frequentlyOrdered: { status: 'ok', items: [{ itemId, orders }] }
 *                        | { status: 'error' } }
 * No price and no photo: the items are the caller's own rows (their scope key,
 * resolved with their own client), and kits and Frequently ordered never name
 * another. The sites, the kits and Frequently ordered answer
 * { status: 'error' } when still running 2.5 s after the catalog arrived.
 * 401; 429 (retry-after; order-storefront:<user>, 120 a minute, shared with
 * the storefront read); 500 internal_error when the catalog itself failed.
 * Private, no-store, and names the organization.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return storefrontUnauthenticated();

  const rl = await checkRateLimit(`order-storefront:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return storefrontRateLimited(rl.resetAt, ctx.organizationId);

  try {
    return storefrontJson(
      await new OrderStorefrontService(ctx).catalog(req.nextUrl.searchParams.get('warehouseId')),
    );
  } catch (e) {
    return storefrontError(e, ctx.organizationId, 'api.v1.orders.catalog');
  }
}
