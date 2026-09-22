import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { ADJUST_WAREHOUSE_WRITE_REFUSED, InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * A HARD END to the window in which this write can still commit.
 *
 * The project runs Fluid compute with a 300 s default function timeout
 * (Vercel project settings, read 2026-09-22), and no vercel.json glob covers
 * this path, so without this line a stalled request could run, and commit, for
 * up to five minutes after the phone gave up on it at api()'s 20 s timeout.
 * The phone treats such an outcome as UNCONFIRMED and keeps the on-hand
 * labelled until either a read shows the change or the write can no longer
 * land (UNCONFIRMED_SETTLE_MS in apps/mobile/src/lib/unconfirmed-stock.ts).
 * That second bound is only honest if this one exists: 30 s here, plus the
 * database's own 8 s statement_timeout for the authenticated role (pg_roles,
 * read 2026-09-22), plus queueing ahead of it. 30 s is past the phone's own
 * 20 s wait (DEFAULT_TIMEOUT_MS in apps/mobile/src/lib/api.ts), so the server
 * never cuts off a request the phone is still waiting for.
 */
export const maxDuration = 30;

/**
 * Mobile QUICK ADJUST — the REST parity for the web stock adjustment
 * (InventoryService.adjustStock, reached from the item page / adjust dialog).
 *
 * Why this route exists at all: the phone called the `adjust_stock` RPC
 * DIRECTLY with a null location — the scan tab until 2026-09-05, when this
 * route was added for it, and the item screen's -5/-1/+1/+5 buttons and
 * "Adjust with reason" sheet until 2026-09-22. That is the exact hole the
 * sibling remove-stock route's header warns about — "Mobile MUST go through the
 * service, or a member without stock:adjust could remove stock by calling the
 * RPC directly" — and it was live on the quick-adjust buttons. Four things went
 * wrong on that path, all fixed by routing here:
 *
 *   1. PERMISSION. The RPC checks only `has_org_role(org, 'staff')` (0327) and
 *      the stock_movements write policy is ADDITIVE (`has_org_role(...,'staff')
 *      OR has_permission(...,'stock:adjust')`, 0321), so a 0207 override with
 *      granted=false never binds at RLS. Web refuses via assertPermission;
 *      mobile did not, so a revoked staffer kept adjusting from the phone.
 *   2. STAGING. adjust_stock routes a NULL-location POSITIVE delta into the
 *      Staging bucket (0341 "INCREMENT: land in Staging"), so a manual +1 from
 *      the phone appeared in the put-away worklist as if it were an unprocessed
 *      receipt. adjustStock resolves the item's rack/Unplaced instead.
 *   3. DRAW MODE. Omitting p_mode leaves the default 'placed' path, which
 *      raises `insufficient_placed_stock` for an item whose only unit sits in
 *      Staging — the L4L 2026-08-17 incident. adjustStock passes mode 'any' for
 *      manual null-location removals.
 *   4. The RPC writes no audit row and fires no `stock.low` webhook; the
 *      service does both.
 *
 * Body: { quantityChange, movementType?, reason?, notes? }. No `locationId`:
 * this is the quick-adjust surface, and letting the service resolve the
 * location is precisely rule 2 above. A location-scoped draw-down is the
 * remove-stock route; a move is the transfer route.
 */
const bodySchema = z.object({
  // `.finite()` rejects "Infinity"/"NaN" that coerce would otherwise pass; the
  // ±1,000,000 bound mirrors packages/core adjustStockSchema (the numeric(14,4)
  // column bound). A ZERO delta is refused here rather than silently writing a
  // no-op movement row into the item history.
  quantityChange: z.coerce
    .number()
    .finite()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, 'Enter a non-zero quantity.'),
  // Only the three MANUAL kinds. 'receive_po'/'transfer'/'initial' are written
  // by their own flows and must never be mintable from a quick-adjust tap.
  movementType: z.enum(['add', 'remove', 'adjust']).optional(),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's stock:adjust
  // gate. 60/min is far above a human tapping +1 on a scanned item.
  const rl = await checkRateLimit(`stock-adjust:${ctx.userId}`, 60, 60_000);
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
    // Fail-fast on authorization BEFORE the service reads the item — a caller
    // without stock:adjust shouldn't learn whether the item exists.
    // adjustStock asserts it again (defense in depth).
    assertPermission(ctx, 'stock:adjust');

    const item = (await new InventoryService(ctx).adjustStock({
      itemId: id,
      quantityChange: body.quantityChange,
      // Default from the SIGN, not zod's 'adjust': a phone tap of −1 is a
      // removal in the item history, and mislabelling it would corrupt the
      // movement-kind filters that Activity and the exports read.
      movementType: body.movementType ?? (body.quantityChange > 0 ? 'add' : 'remove'),
      reason: body.reason,
      notes: body.notes,
    })) as { quantity_on_hand?: number } | null;

    // The adjustment changes the on-hand total shown in the cached Items/Books
    // views — refresh the org cache, same as every other stock write.
    //
    // The stock movement has COMMITTED by this line. An invalidation that
    // threw used to fall into the catch below and answer 500, telling the
    // phone its adjustment failed when it had not: the operator taps again
    // and the stock moves twice. Since 2026-09-22 the iPhone item screen's
    // +/-1, +/-5 and "Adjust with reason" all land here (they called the RPC
    // directly before), so this is the write path for every manual phone
    // adjustment. A missed invalidation costs at most the 60 s list-cache
    // window; a false failure costs a double count. Report it, never fail.
    try {
      revalidateInventoryList(ctx.organizationId);
    } catch (err) {
      void reportError(err, { tag: 'api.v1.items.adjust.revalidate' });
    }

    // adjust_stock is atomic and RETURNS the authoritative row, so the phone can
    // render the true new quantity instead of its own optimistic arithmetic
    // (which drifts the moment two people adjust the same item).
    return NextResponse.json({
      ok: true,
      ...(typeof item?.quantity_on_hand === 'number'
        ? { quantityOnHand: Number(item.quantity_on_hand) }
        : {}),
    });
  } catch (e) {
    // The service already maps the RPC's raise-exception strings
    // (insufficient_placed_stock BEFORE insufficient_stock — they are different
    // classes and the general one does not contain the specific one) plus the
    // archived-item refusal into ServiceErrors with human copy. Pass those
    // through verbatim; only a genuinely unknown failure becomes a 500.
    if (e instanceof ServiceError) {
      return NextResponse.json(
        {
          error: e.code,
          message: e.message,
          // `details` is app-authored for every code except internal_error
          // (whose detail is raw DB text, S13) — the same rule the transfer
          // route applies. It is what carries `reason: 'aal2_required'` from
          // the MFA gate (mfaGateError), which the phone needs to tell "sign in
          // again with your authenticator" apart from "you lack stock:adjust";
          // both are a 403 'forbidden' and only this field differs.
          ...(e.code !== 'internal_error' && e.details ? { details: e.details } : {}),
        },
        { status: serviceErrorStatus(e.code) },
      );
    }
    // The warehouse helpers throw ForbiddenError, not ServiceError. adjustStock
    // converts its own warehouse refusal, but any ForbiddenError that still
    // reaches here is an authorization refusal decided BEFORE the write, and
    // must never become a 500: the phone reads a 5xx as "may or may not have
    // been saved" and the operator taps again. Its raw message names the
    // warehouse uuid, so the phone gets the fixed sentence instead.
    if (e instanceof ForbiddenError) {
      return NextResponse.json(
        { error: 'forbidden', message: ADJUST_WAREHOUSE_WRITE_REFUSED },
        { status: 403 },
      );
    }
    void reportError(e, { tag: 'api.v1.items.adjust' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
