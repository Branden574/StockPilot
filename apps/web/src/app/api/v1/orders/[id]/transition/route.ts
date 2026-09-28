import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { ForbiddenError } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { OrderRequestsService } from '@/server/services/order-requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile order-pipeline transitions — the REST parity for the web
 * ManagerActionsPanel (which uses server actions, web-only). One dispatcher over
 * OrderRequestsService; each method self-gates module + permission + status, so
 * this stays a thin wrapper and authorization is enforced server-side (a member
 * without the right role gets the service's ServiceError → 403, never a bypass).
 *
 * Body: { action, reason?, target?, deliveryUserId?, internalNotes? }
 *
 * Every action answers { order }, except hold_stock (F2-2, "Hold available
 * stock"), which answers { hold: { held: [{itemId, added}], stillShort:
 * [{itemId, quantity}] } } and leaves the status alone. Its refusals come
 * mapped from OrderRequestsService.holdStock: 404 order not found, 403
 * forbidden (not an approver, no write access to the order's warehouse, or a
 * step-up needed) and module_disabled, 409 conflict (not approved or being
 * picked; or someone else held the order or an item for 5 s), 500 anything
 * else.
 */
const bodySchema = z.object({
  action: z.enum([
    'approve',
    'approve_partial',
    'deny',
    'generate_pick_slip',
    'claim_picking',
    'assign_picking',
    'release_picking',
    'complete_picking',
    'reopen_picking',
    'generate_packing_slips',
    'stage',
    'assign_delivery',
    'mark_in_transit',
    'resume_fulfillment',
    'close_partial',
    'confirm_physical_signature',
    'cancel',
    'hold_stock',
  ]),
  reason: z.string().max(500).optional(),
  target: z.enum(['staged_for_pickup', 'staged_for_delivery']).optional(),
  deliveryUserId: z.string().uuid().optional(),
  /** Required for assign_picking (the member to assign as picker). */
  pickerUserId: z.string().uuid().optional(),
  /** Required for confirm_physical_signature (who signed the paper). */
  signerName: z.string().min(1).max(120).optional(),
  internalNotes: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle on order mutations — defense-in-depth on top of the
  // service's module/role/status gates. 60/min/user is far above real use
  // (a manager tapping through a pipeline) but stops scripted abuse.
  const rl = await checkRateLimit(`order-transition:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } },
    );
  }

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: parsed.error.issues[0]?.message ?? 'Invalid request' },
      { status: 400 },
    );
  }
  const a = parsed.data;
  const svc = new OrderRequestsService(ctx);

  try {
    let order;
    switch (a.action) {
      case 'approve':
        order = await svc.approve(id, a.internalNotes ?? null);
        break;
      case 'approve_partial':
        order = await svc.approvePartial(id);
        break;
      case 'deny':
        if (!a.reason?.trim()) {
          return NextResponse.json(
            { error: 'validation_error', message: 'A reason is required to deny.' },
            { status: 400 },
          );
        }
        order = await svc.deny(id, a.reason.trim());
        break;
      case 'generate_pick_slip':
        order = await svc.generatePickSlip(id);
        break;
      case 'claim_picking':
        order = await svc.claimPicking(id);
        break;
      case 'assign_picking':
        if (!a.pickerUserId) {
          return NextResponse.json(
            { error: 'validation_error', message: 'A picker is required to assign.' },
            { status: 400 },
          );
        }
        order = await svc.assignPicking(id, a.pickerUserId);
        break;
      case 'release_picking':
        order = await svc.releasePicking(id);
        break;
      case 'complete_picking':
        order = await svc.completePicking(id);
        break;
      case 'reopen_picking':
        if (!a.reason || a.reason.trim() === '') {
          return NextResponse.json(
            { error: 'validation_error', message: 'A reason is required to reopen picking.' },
            { status: 400 },
          );
        }
        order = await svc.reopenPicking(id, a.reason.trim());
        break;
      case 'generate_packing_slips':
        order = await svc.generatePackingSlips(id);
        break;
      case 'stage':
        if (!a.target) {
          return NextResponse.json(
            { error: 'validation_error', message: 'A staging target is required.' },
            { status: 400 },
          );
        }
        order = await svc.stageOrder(id, a.target);
        break;
      case 'assign_delivery':
        if (!a.deliveryUserId) {
          return NextResponse.json(
            { error: 'validation_error', message: 'A delivery user is required.' },
            { status: 400 },
          );
        }
        order = await svc.assignDelivery(id, a.deliveryUserId);
        break;
      case 'mark_in_transit':
        order = await svc.markInTransit(id);
        break;
      case 'resume_fulfillment':
        order = await svc.resumeFulfillment(id);
        break;
      case 'close_partial':
        order = await svc.closePartial(id);
        break;
      case 'confirm_physical_signature': {
        const signer = a.signerName?.trim();
        if (!signer) {
          return NextResponse.json(
            { error: 'validation_error', message: 'signerName is required' },
            { status: 400 },
          );
        }
        order = await svc.confirmPhysicalSignature(id, signer);
        break;
      }
      case 'cancel':
        order = await svc.cancel(id, a.reason?.trim() || null);
        break;
      case 'hold_stock': {
        // Holds move availability: bust the storefront catalog like every
        // reserve/release transition, and answer what was held.
        const hold = await svc.holdStock(id);
        revalidateTag('orders-new-v2-catalog', 'max');
        return NextResponse.json({ hold });
      }
    }
    // complete_picking decrements stock, cancel restocks picked stock, and
    // reopen_picking reverses complete_picking's draw (restocks) — all three
    // change the cached Items/Books default views. The other actions
    // (including resume/close_partial, which only move reservations) are
    // status-only; one cheap tag revalidate covers the set.
    if (a.action === 'complete_picking' || a.action === 'cancel' || a.action === 'reopen_picking') {
      revalidateInventoryList(ctx.organizationId);
    }
    // Every transition can move availability (reserve/release/decrement) —
    // bust the storefront catalog so "avail" pills update near-instantly
    // (mobile transitions must refresh the web Place-an-Order page too).
    revalidateTag('orders-new-v2-catalog', 'max');
    return NextResponse.json({ order });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    // assertWarehouseAccess (every requireWarehouseAccess gate) throws
    // ForbiddenError, a separate class from ServiceError: without this a
    // permanent refusal fell through to a generic 500 and an error report
    // (the lines route's fix, applied here too).
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: 'forbidden', message: e.message }, { status: 403 });
    }
    void reportError(e, { tag: 'api.v1.orders.transition', extra: { action: a.action } });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
