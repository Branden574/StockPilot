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
 * Stock-movement HISTORY for one item, for mobile (Bearer auth).
 *
 * Calls the SAME InventoryService.itemMovementHistory() the web staging dialog
 * calls rather than re-querying. The 2026-07-22 incident was two surfaces
 * disagreeing about where staged stock came from; a second query here would
 * reintroduce exactly that drift. Rows go over the wire verbatim and the app
 * renders them through the shared @stockpilot/core formatter, so the phone
 * reads the same words as the browser — including the raw ISO timestamps,
 * which each surface formats in the VIEWER's timezone.
 *
 * Read-only.
 */
const querySchema = z.object({
  // Page size. The service clamps to 2000; validated here so a nonsense value
  // is a 400 rather than being silently coerced.
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await withApiContext(req);
    if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    // Route-level gate matching the web page: RLS alone would return an empty
    // history rather than refuse, which reads as "nothing ever happened"
    // instead of "not allowed".
    if (!can(ctx, 'items:read')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const rl = await checkRateLimit(`item-history:${ctx.userId}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', retryAt: rl.resetAt },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) },
        },
      );
    }

    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json(
        { error: 'validation_error', message: 'Invalid item id' },
        { status: 400 },
      );
    }

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid query' },
        { status: 400 },
      );
    }

    const svc = new InventoryService(ctx);
    const page = await svc.itemMovementHistory({
      itemId: id,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
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
    void reportError(e, { tag: 'api.v1.items.history' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
