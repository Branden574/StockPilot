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
 * Mobile "Move stock" — the REST parity for the web StockTransferDialog and the
 * Staging put-away flow (both web-only, driven by server actions). It moves a
 * quantity of one item from a SOURCE holding (a rack/crate, or a staging/
 * unplaced bucket for put-away) into a DESTINATION rack/crate.
 *
 * Why a REST route and not a direct RPC from the app: the transfer_stock RPC
 * only checks the staff-role floor. The 'stock:transfer' PERMISSION is asserted
 * in InventoryService.transferStock — so mobile MUST go through the service, or
 * a member without stock:transfer could move stock by calling the RPC directly.
 *
 * Body: { fromLocationId, toLocationId, quantity, notes? }
 *
 * Defense in depth (three independent org-scoping layers, none sufficient to
 * bypass alone): (1) transfer_stock reads the item under the CALLER's RLS, so a
 * foreign-org itemId is invisible → item_not_found; (2) the RPC asserts BOTH
 * locations belong to the item's org (assert_location_in_org, mig 0201/0231);
 * (3) this route additionally pins the destination to THIS session's org
 * (ctx.organizationId) and rejects the staging/unplaced system buckets — which
 * also gives a clean 400 instead of a generic RPC 500. Inline rack CREATION is
 * web-only for now; mobile picks an existing destination.
 */
const bodySchema = z
  .object({
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    // `.finite()` rejects "Infinity"/"NaN" that coerce would otherwise pass.
    quantity: z.coerce.number().positive().finite(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, {
    message: 'Source and destination must be different locations.',
    path: ['toLocationId'],
  });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's stock:transfer
  // gate. 60/min is far above a human tapping through put-away.
  const rl = await checkRateLimit(`stock-transfer:${ctx.userId}`, 60, 60_000);
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
    // Fail-fast on authorization BEFORE probing any locations — a caller without
    // stock:transfer shouldn't even learn whether a location exists. Throws
    // ServiceError('forbidden') → 403; transferStock asserts it again (defense
    // in depth).
    assertPermission(ctx, 'stock:transfer');

    // TENANT-ISOLATION GUARD: pin the destination to THIS session's org and
    // reject the staging/unplaced system buckets. transfer_stock already asserts
    // both locations belong to the item's org (assert_location_in_org, 0201/0231);
    // this additionally ties the destination to ctx.organizationId (matters for a
    // dual-org member) and yields a clean 400 rather than a generic RPC 500.
    const { data: dest } = await ctx.supabase
      .from('locations')
      .select('id, kind')
      .eq('id', body.toLocationId)
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!dest) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: 'Destination location not found in your organization.',
        },
        { status: 400 },
      );
    }
    if (dest.kind === 'staging' || dest.kind === 'unplaced') {
      return NextResponse.json(
        { error: 'validation_error', message: 'Pick a rack or crate as the destination.' },
        { status: 400 },
      );
    }

    // Re-asserts 'stock:transfer' internally, then calls transfer_stock.
    const svc = new InventoryService(ctx);
    await svc.transferStock({
      itemId: id,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      notes: body.notes,
    });

    // A move re-slices this item's placement holdings shown in the cached
    // Items/Books views — refresh the org's list cache (on-hand total is
    // unchanged, but the per-rack breakdown is not).
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true, toLocationId: body.toLocationId });
  } catch (e) {
    // transfer_stock raises `insufficient_stock` (P0001); the service wraps it as
    // ServiceError('internal_error', ...) with the raw text on internalDetail
    // (public message is sanitized — S13). Map it to a friendly 400.
    if (
      e instanceof ServiceError &&
      e.code === 'internal_error' &&
      (e.internalDetail ?? '').toLowerCase().includes('insufficient_stock')
    ) {
      return NextResponse.json(
        {
          error: 'validation_error',
          message: "Can't move more than is available in the source location.",
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
    void reportError(e, { tag: 'api.v1.items.transfer' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
