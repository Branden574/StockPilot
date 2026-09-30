'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  can,
  err,
  ok,
  READINESS_FORBIDDEN_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  SHORTFALL_PO_FAILED_COPY,
  SHORTFALL_PO_INVALID_COPY,
  SHORTFALL_PO_KEY_MAX,
  SHORTFALL_PO_MAX_LINES,
  type ActionResult,
  type OrderReadinessResult,
  type ShortfallPoResult,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, withContext, type ServiceContext } from '@/server/services/context';
import { OrderReadinessService } from '@/server/services/order-readiness';

const readSchema = z.object({ id: z.string().uuid() });

/** What a failed context (signed out, no organization) reads as. */
const READ_FAILED_MESSAGE = 'Could not check readiness.';

/**
 * Read an order's readiness AGAIN, after "Approve partial" or "Resume
 * fulfillment" committed (F2-3, the order page's approve-partial dialog).
 *
 * The dialog's message is computed from THIS read (core describePartialResult,
 * the order's own holds, `heldOwn`), never from the preview it showed before
 * the commit: the commit re-checks stock inside its own transaction, and stock
 * can move in between. The same read the order page makes
 * (OrderReadinessService.result: order_readiness_facts as the caller, judged
 * by core), so the dialog and the strip under it say the same thing.
 *
 * READ ONLY. It writes nothing, and it never throws: any failure is
 * `{ state: 'failed' }` (the service reports its own faults), which the dialog
 * words as "What is held now couldn't be checked", claiming no number. A
 * missing session does not redirect from here: the commit already happened,
 * and the message says it could not be checked.
 *
 * WHO. Its only caller follows approve partial and resume, which both assert
 * `orders:approve`; anyone else is refused before any read. The facts function
 * gates every field for the reader in its own body (0377).
 */
export async function readOrderReadinessAction(
  input: z.input<typeof readSchema>,
): Promise<OrderReadinessResult> {
  const parsed = readSchema.safeParse(input);
  if (!parsed.success) return { state: 'failed', message: READINESS_ORDER_NOT_FOUND_COPY };
  let ctx: ServiceContext;
  try {
    ctx = await withContext();
  } catch {
    return { state: 'failed', message: READ_FAILED_MESSAGE };
  }
  if (!can(ctx, 'orders:approve')) return { state: 'failed', message: READINESS_FORBIDDEN_COPY };
  return new OrderReadinessService(ctx).result(parsed.data.id);
}

const draftShortfallSchema = z.object({
  orderId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        // Checked again by the service and the function (above 0 on the
        // 4-decimal grid, at most what may be drafted); this bound only stops
        // an absurd payload.
        quantity: z.number().finite().positive().max(1e10),
      }),
    )
    .min(1)
    .max(SHORTFALL_PO_MAX_LINES),
  idempotencyKey: z.string().trim().min(1).max(SHORTFALL_PO_KEY_MAX),
});

/**
 * Draft purchase orders for what an order is short (F2-5), from the order
 * page's dialog: one draft per supplier plus one for the items with no
 * supplier, all or nothing. The same service as the phone's route
 * (OrderReadinessService.draftShortfallPos: both modules, a manager with
 * purchase_orders:manage, write access to the order's warehouse, then
 * draft_order_shortfall_pos, 0385). A refusal comes back in core's words with
 * `details.reason` (and `details.current`, the most that may be drafted per
 * item now, after shortfall_changed); a fault is core's "couldn't be created"
 * sentence (the service reported it with its cause). Drafts are not sent.
 */
export async function draftShortfallPosAction(
  input: z.input<typeof draftShortfallSchema>,
): Promise<ActionResult<ShortfallPoResult>> {
  const parsed = draftShortfallSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', SHORTFALL_PO_INVALID_COPY, { reason: 'invalid' });
  try {
    const svc = await OrderReadinessService.forCurrentUser();
    const result = await svc.draftShortfallPos(parsed.data);
    if (!result.replay) {
      revalidatePath('/dashboard/purchase-orders');
      revalidatePath(`/dashboard/orders/${parsed.data.orderId}`);
    }
    return ok(result);
  } catch (e) {
    if (e instanceof ServiceError && e.code !== 'internal_error') return err(e.code, e.message, e.details);
    if (!(e instanceof ServiceError)) void reportError(e, { tag: 'actions.orders.shortfall_po' });
    return err('internal_error', SHORTFALL_PO_FAILED_COPY, { reason: 'failed' });
  }
}
