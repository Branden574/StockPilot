import type { NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  manageError,
  manageJson,
  manageRateLimited,
  manageUnauthenticated,
} from '@/server/lib/order-catalog-visibility-http';
import { OrderCatalogVisibilityService } from '@/server/services/order-catalog-visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/orders/catalog-visibility/family/[groupId] (ordering visibility,
 * 0413; design 4.1): the records of one product family the caller can read,
 * for the explicit "Select family" disclosure only, at most 200. Cookie or
 * bearer; the same gates as the list.
 *
 * 200 OrderCatalogFamilyAnswer:
 *   { organizationId, familyId, familyName, rows: OrderCatalogManageRow[],
 *     truncated }
 * 400 validation_error (details.reason 'invalid', field 'groupId') for an id
 * that is not a uuid. A family with no readable record answers rows: [].
 * Shares the list's read limit (order-catalog-manage:<user>, 120 a minute).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return manageUnauthenticated();

  const rl = await checkRateLimit(`order-catalog-manage:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return manageRateLimited(rl.resetAt, ctx.organizationId);

  try {
    const { groupId } = await params;
    return manageJson(await new OrderCatalogVisibilityService(ctx).familyMembers(groupId));
  } catch (e) {
    return manageError(e, ctx.organizationId, 'api.v1.orders.catalog-visibility.family', 'read');
  }
}
