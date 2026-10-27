import type { NextRequest } from 'next/server';

import { ORDER_ITEMS_INVALID_COPY, parseOrderCatalogManageQuery } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  manageError,
  manageInvalidBody,
  manageJson,
  manageRateLimited,
  manageUnauthenticated,
} from '@/server/lib/order-catalog-visibility-http';
import { OrderCatalogVisibilityService } from '@/server/services/order-catalog-visibility';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manage order items (ordering visibility, migration 0413; design 4.1 to 4.3),
 * for the web page and the phone, cookie or bearer. The organization is the
 * verified membership's only (withApiContext); no platform flag is taken.
 *
 * GET ?q&visibility=all|shown|hidden&type=all|items|books&warehouseId&categoryId&page
 *   (core parseOrderCatalogManageQuery: anything malformed falls back to its
 *   default). 200 OrderCatalogManageListAnswer:
 *   { organizationId, viewer: { canManage: true }, page, pageSize: 25, total,
 *     rows: [{ id, name, sku, identifier, itemType: 'item' | 'book',
 *              sizeOrEdition, warehouseId, warehouseName, categoryName,
 *              familyId, familyName, expected, visible, hiddenSince, thumbUrl }] }
 *   Read limit: order-catalog-manage:<user>, 120 a minute (429).
 *
 * POST { itemIds: uuid[] (1 to 500), visible: boolean, operationId: uuid }
 *   Show or Hide exactly those records, all or nothing, surface 'app'. 200
 *   OrderCatalogVisibilityWriteAnswer:
 *   { organizationId, operationId, visible, changed: uuid[], unchanged: uuid[] }
 *   A retry with the same operationId answers every id as unchanged. Write
 *   limit: order-catalog-visibility:<user>, 60 a minute (429, in the service).
 *
 * Refusals and faults: see server/lib/order-catalog-visibility-http.ts.
 * Private, no-store, and every answer names the organization.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return manageUnauthenticated();

  const rl = await checkRateLimit(`order-catalog-manage:${ctx.userId}`, 120, 60_000);
  if (!rl.allowed) return manageRateLimited(rl.resetAt, ctx.organizationId);

  try {
    const query = parseOrderCatalogManageQuery(req.nextUrl.searchParams);
    return manageJson(await new OrderCatalogVisibilityService(ctx).list(query));
  } catch (e) {
    return manageError(e, ctx.organizationId, 'api.v1.orders.catalog-visibility.list', 'read');
  }
}

export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return manageUnauthenticated();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return manageInvalidBody(ctx.organizationId, ORDER_ITEMS_INVALID_COPY);
  }
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<
    string,
    unknown
  >;

  try {
    return manageJson(
      await new OrderCatalogVisibilityService(ctx).setVisibility({
        itemIds: b.itemIds,
        visible: b.visible,
        operationId: b.operationId,
        surface: 'app',
      }),
    );
  } catch (e) {
    return manageError(e, ctx.organizationId, 'api.v1.orders.catalog-visibility.set', 'write');
  }
}
