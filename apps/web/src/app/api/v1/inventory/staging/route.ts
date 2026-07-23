import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { checkRateLimit } from '@/lib/rate-limit';
import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

import { can } from '@stockpilot/core';

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
 */
const querySchema = z.object({
  // Mirrors the web page's ?type= param (Items / Books filter).
  type: z.enum(['book', 'non-book']).optional(),
  // The web page reads the active-warehouse cookie; mobile has no cookie, so it
  // passes the id explicitly. Omitted = all warehouses the caller can see.
  warehouseId: z.string().uuid().optional(),
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
    const parsed = querySchema.safeParse({
      type: url.searchParams.get('type') ?? undefined,
      warehouseId: url.searchParams.get('warehouseId') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid query' },
        { status: 400 },
      );
    }

    const svc = new InventoryService(ctx);
    const rows = await svc.stagedWorklist({
      itemType: parsed.data.type,
      warehouseId: parsed.data.warehouseId ?? null,
    });

    return NextResponse.json(
      { rows, canPlace: can(ctx, 'stock:transfer') },
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
