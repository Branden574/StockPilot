import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Remove from rack" — the REST parity for the web write-off (server
 * action removeStockFromLocationAction). It removes (writes off) a quantity of
 * ONE item from ONE holding, leaving its stock in every OTHER location
 * untouched — the tool a warehouse manager reaches for after consolidating a
 * rack, instead of archiving (which would hide the whole item and orphan the
 * stock it holds elsewhere).
 *
 * Body: { locationId, reason, quantity? }
 *   - locationId: the rack/crate/bucket to draw down (an item_stock_levels holding).
 *   - reason: MANDATORY free text, stored verbatim on the movement.
 *   - quantity: optional. Omit to remove the WHOLE holding (mobile's "clear this
 *     rack" — the full quantity is resolved server-side so the client never has
 *     to compute it); a positive value removes exactly that much, capped at the
 *     holding by the service.
 *
 * Why a REST route and not a direct RPC: the write-off runs through
 * InventoryService.removeStockFromLocation → adjustStock, which asserts the
 * 'stock:adjust' PERMISSION (the adjust_stock RPC only checks the staff-role
 * floor). Mobile MUST go through the service, or a member without stock:adjust
 * could remove stock by calling the RPC directly.
 */
const bodySchema = z.object({
  locationId: z.string().uuid(),
  // `.finite()` rejects "Infinity"/"NaN" that coerce would otherwise pass.
  quantity: z.coerce.number().positive().finite().max(1_000_000).optional(),
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required to remove stock.')
    .max(500),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's stock:adjust
  // gate. 60/min is far above a human tapping through a rack clear-out.
  const rl = await checkRateLimit(`stock-remove:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid item id.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    // Fail-fast on authorization BEFORE probing the holding — a caller without
    // stock:adjust shouldn't learn whether a location holds anything.
    // removeStockFromLocation asserts it again (defense in depth).
    assertPermission(ctx, 'stock:adjust');

    const svc = new InventoryService(ctx);

    // Resolve the default quantity server-side when the client asks to clear the
    // whole rack (quantity omitted). Scoped to THIS session's org so a foreign
    // location id reads as empty rather than leaking existence.
    let quantity = body.quantity;
    if (quantity == null) {
      const { data: level } = await ctx.supabase
        .from('item_stock_levels')
        .select('quantity')
        .eq('organization_id', ctx.organizationId)
        .eq('item_id', id)
        .eq('location_id', body.locationId)
        .maybeSingle();
      quantity = Number((level as { quantity?: number } | null)?.quantity ?? 0);
      if (!(quantity > 0)) {
        return NextResponse.json(
          { error: 'validation_error', message: 'That location holds no stock for this item.' },
          { status: 400 },
        );
      }
    }

    await svc.removeStockFromLocation({
      itemId: id,
      locationId: body.locationId,
      quantity,
      reason: body.reason,
    });

    // A write-off re-slices this item's placement holdings shown in the cached
    // Items/Books views (and drops the on-hand total) — refresh the org cache.
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // adjust_stock raises `insufficient_stock` (P0001) if the delta would push
    // on-hand negative; the service wraps it. Map to a friendly 400 rather than
    // surfacing an internal_error 500.
    if (
      e instanceof ServiceError &&
      e.code === 'internal_error' &&
      (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock')
    ) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: "Can't remove more than is in this location.",
        },
        { status: 400 },
      );
    }
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.items.remove-stock' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
