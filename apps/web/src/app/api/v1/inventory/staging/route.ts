import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { OrderRequestsService } from '@/server/services/order-requests';

import { can, STAGING_FILTER_MAX_ITEMS } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Staging put-away worklist for mobile (Bearer auth).
 *
 * Deliberately calls the SAME InventoryService.stagedWorklist() the web page
 * calls rather than re-querying: the whole 2026-07-22 incident was the two
 * surfaces disagreeing about where staged stock came from, and a second query
 * here would reintroduce exactly that drift. Rows are returned verbatim — the
 * same fields the web table renders (source PO/receipt, received date, age,
 * warehouse) — and the app formats them with mirrors of the web cells, so the
 * phone reads the same words as the browser.
 *
 * Read-only. The Place action stays on POST /api/v1/items/[id]/transfer, which
 * asserts 'stock:transfer' server-side; `canPlace` is returned here only so the
 * app can hide a button that would always fail.
 *
 * PUT AWAY FROM AN ORDER (F2-3). `itemIds` narrows the list to those items (a
 * comma list, at most 200 uuids; a bad id or more than 200 is a 400, never a
 * silently different list), filtered in the service's query, and the
 * warehouse filter is then ignored (the ids already narrow it). `orderId`
 * names the order the items came from: the answer carries `order` (its
 * number, for the chip "Showing items from SO-000123", and whether it exists
 * to go back to), read beside the worklist, never after it. Both are
 * additive: an older app never sends them and ignores `order`.
 */
/** A comma list of item ids (the phone's `itemIds`), repeated params joined.
 *  Duplicates are removed BEFORE the 200 cap, as core parseStagingItemFilter
 *  and the service do, so the three layers accept the same lists. */
const itemIdsSchema = z
  .string()
  .transform((v) => [...new Set(v.split(',').map((s) => s.trim().toLowerCase()))])
  .pipe(
    z
      .array(z.string().uuid('Each item id must be a UUID'))
      .max(STAGING_FILTER_MAX_ITEMS, `At most ${STAGING_FILTER_MAX_ITEMS} item ids`),
  );

const querySchema = z.object({
  // Mirrors the web page's ?type= param (Items / Books filter).
  type: z.enum(['book', 'non-book']).optional(),
  // The web page reads the active-warehouse cookie; mobile has no cookie, so it
  // passes the id explicitly. Omitted = all warehouses the caller can see.
  // Ignored when itemIds is set.
  warehouseId: z.string().uuid().optional(),
  itemIds: itemIdsSchema.optional(),
  orderId: z.string().uuid().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    // Route-level gate matching the web page: RLS alone would return an empty
    // list rather than refuse, which reads as "nothing staged" instead of
    // "not allowed".
    if (!can(ctx, 'items:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const rl = await checkRateLimit(`inventory-staging:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', retryAt: rl.resetAt },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
        },
      );
    }

    const url = new URL(req.url);
    const itemIdParams = url.searchParams.getAll('itemIds');
    const parsed = querySchema.safeParse({
      type: url.searchParams.get('type') ?? undefined,
      warehouseId: url.searchParams.get('warehouseId') ?? undefined,
      itemIds: itemIdParams.length > 0 ? itemIdParams.join(',') : undefined,
      orderId: url.searchParams.get('orderId') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid query' },
        { status: 400 },
      );
    }

    const svc = new InventoryService(ctx);
    const { itemIds, orderId } = parsed.data;
    // The order's number is read BESIDE the worklist (no serial round trip),
    // and never fails the list (orderLinkLabel does not throw).
    const [rows, order] = await Promise.all([
      svc.stagedWorklist({
        itemType: parsed.data.type,
        warehouseId: parsed.data.warehouseId ?? null,
        ...(itemIds ? { itemIds } : {}),
      }),
      orderId ? new OrderRequestsService(ctx).orderLinkLabel(orderId) : Promise.resolve(null),
    ]);

    return NextResponse.json(
      {
        rows,
        canPlace: can(ctx, 'stock:transfer'),
        // null without an orderId. `found` false: no such order to go back
        // to; `orderNumber` null with `found` true: its number could not be
        // read (the link still works).
        order:
          order === null
            ? null
            : order.state === 'ok'
              ? { id: order.id, orderNumber: order.orderNumber, found: true }
              : order.state === 'failed'
                ? { id: orderId!, orderNumber: null, found: true }
                : { id: orderId!, orderNumber: null, found: false },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    // getWarehouseAccess and friends throw ForbiddenError, not ServiceError —
    // several v1 routes have previously let it fall through to a generic 500.
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.inventory.staging' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
