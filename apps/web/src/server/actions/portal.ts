'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolvePortalContext, portalSubmitOrder, type PortalSubmitInput } from '@/server/services/portal';
import { createPortalReturn } from '@/server/services/returns';
import { exchangeOptionsForPortal, loadPortalReturnSheet } from '@/server/services/returns-requester';
import { ServiceError } from '@/server/services/context';

import {
  err,
  ok,
  RETURNS_COPY,
  type ActionResult,
  type RequesterExchangeOptionsAnswer,
  type RequesterReturnSheet,
} from '@stockpilot/core';

/**
 * Portal checkout. Re-resolves the portal context server-side on every call —
 * the CLIENT is never trusted for customer identity; the signed-in auth user
 * either maps to an active customer or the action refuses.
 */
export async function submitPortalOrderAction(
  input: PortalSubmitInput,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await resolvePortalContext();
  if (!ctx) return err('forbidden', 'Your account does not have portal access.');
  try {
    const created = await portalSubmitOrder(ctx, input);
    revalidatePath('/portal');
    return ok(created);
  } catch (e) {
    return err('validation_error', e instanceof Error ? e.message : 'Order could not be submitted.');
  }
}

// ── Request a return (portal customer) ──────────────────────────────────────

const portalReturnSchema = z.object({
  orderId: z.string().uuid(),
  reasonCode: z.enum(['damaged', 'wrong_item', 'end_of_year', 'overage', 'other']).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z
    .array(
      z.object({
        orderRequestLineId: z.string().uuid(),
        quantity: z.number().int().positive().max(10_000),
        // Returns RX-3: "Exchange for another size" (an option's itemId) or
        // "warehouse will review" (a note). Shape only here; core's requester
        // schema and the database decide the rest (one of the line's own
        // sizes, at most the returned quantity, the note's length).
        exchange: z
          .object({
            itemId: z.string().uuid().optional().nullable(),
            quantity: z.number().int().positive().max(10_000).optional().nullable(),
            note: z.string().max(1000).optional().nullable(),
          })
          .strict()
          .optional()
          .nullable(),
      }),
    )
    .min(1)
    .max(100),
  // Minted when the form opens: a resend replays the same RMA.
  idempotencyKey: z.string().uuid().optional(),
});

export type PortalReturnInput = z.input<typeof portalReturnSchema>;

/**
 * Mirrors the public token surface's per-principal cap (10/hr, fail-CLOSED —
 * global constraint for portal/public surfaces: a limiter outage denies
 * rather than opening the floodgates). A legitimate customer files a handful
 * of returns, not dozens per hour.
 */
const RETURN_RATE_LIMIT_PER_USER_PER_HOUR = 10;
/** The sheet and its sizes (reads): fail-closed too. */
const RETURN_READS_PER_USER_PER_HOUR = 120;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * B2B portal "Request a return". The signed-in portal user's context is
 * re-resolved server-side (accepted-mapping-wins; NEVER org_members) and the
 * order is resolved inside the returns service scoped to THAT context's
 * org + customer — a cross-customer or foreign order id is a not_found, so
 * the client-supplied orderId can never reach another tenant's data. The
 * creation itself is the SAME shared requester-return core the public token
 * path uses (durable budget, line belonging, item identity stamped
 * server-side, source='requester', status='requested' → staff approval
 * queue; no inventory moves until staff approve + receive + close).
 *
 * Returns RX-3: a line may ask for an exchange; the database accepts only
 * one of the line's own sizes on the customer's catalog, and the same
 * generic words answer any other item.
 */
export async function requestPortalReturnAction(
  input: PortalReturnInput,
): Promise<ActionResult<{ id: string; status: 'requested'; returnNumber: string | null; replay: boolean }>> {
  const ctx = await resolvePortalContext();
  if (!ctx) return err('forbidden', 'Your account does not have portal access.');

  const parsed = portalReturnSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Please check the form.');
  }

  const limit = await checkRateLimit(
    `portal-return:user:${ctx.userId}`,
    RETURN_RATE_LIMIT_PER_USER_PER_HOUR,
    ONE_HOUR_MS,
    'closed',
  );
  if (!limit.allowed) {
    return err(
      'rate_limited',
      "You've hit the return-request limit. Please wait an hour and try again, or contact your supplier directly.",
    );
  }

  try {
    const created = await createPortalReturn(
      createAdminClient(),
      {
        organizationId: ctx.organizationId,
        customerId: ctx.customerId,
        orderRequestId: parsed.data.orderId,
        // Recorded on the created decision (0394): the portal user asked.
        portalUserId: ctx.userId,
      },
      {
        reasonCode: parsed.data.reasonCode,
        notes: parsed.data.notes || undefined,
        lines: parsed.data.lines.map((l) => ({
          orderRequestLineId: l.orderRequestLineId,
          quantity: l.quantity,
          ...(l.exchange ? { exchange: l.exchange } : {}),
        })),
      },
      { idempotencyKey: parsed.data.idempotencyKey ?? null },
    );
    revalidatePath('/portal');
    return ok({ id: created.id, status: 'requested' as const, returnNumber: created.returnNumber ?? null, replay: created.replay === true });
  } catch (e) {
    return portalReturnRefusal(e, 'portal.return.create', 'Your return request could not be submitted. Please try again.');
  }
}

/**
 * The portal's "Return or exchange" sheet for one of the customer's own
 * orders (returns RX-3): the returnable lines with names, sizes and photos
 * (the portal's first image surface, signed for these items only), the kill
 * switch, and the customer's own requests' progress.
 */
export async function portalReturnSheetAction(orderId: string): Promise<ActionResult<RequesterReturnSheet>> {
  const ctx = await resolvePortalContext();
  if (!ctx) return err('forbidden', 'Your account does not have portal access.');
  if (!z.string().uuid().safeParse(orderId).success) return err('not_found', 'This order could not be found.');
  const limited = await portalReadLimited(ctx.userId);
  if (limited) return limited;
  try {
    const sheet = await loadPortalReturnSheet(createAdminClient(), {
      organizationId: ctx.organizationId,
      customerId: ctx.customerId,
      orderRequestId: orderId,
    });
    return sheet ? ok(sheet) : err('not_found', 'This order could not be found.');
  } catch (e) {
    return portalReturnRefusal(e, 'portal.return.sheet', 'The return form could not be loaded. Please try again.');
  }
}

/**
 * The sizes each returnable line of the customer's own order may be
 * exchanged for (returns RX-3, D6: "Available" or "Not in stock right now",
 * never a count), loaded once, on the first Exchange.
 */
export async function portalReturnOptionsAction(orderId: string): Promise<ActionResult<RequesterExchangeOptionsAnswer>> {
  const ctx = await resolvePortalContext();
  if (!ctx) return err('forbidden', 'Your account does not have portal access.');
  if (!z.string().uuid().safeParse(orderId).success) return err('not_found', 'This order could not be found.');
  const limited = await portalReadLimited(ctx.userId);
  if (limited) return limited;
  try {
    const answer = await exchangeOptionsForPortal(createAdminClient(), {
      organizationId: ctx.organizationId,
      customerId: ctx.customerId,
      orderRequestId: orderId,
    });
    return answer ? ok(answer) : err('not_found', 'This order could not be found.');
  } catch (e) {
    return portalReturnRefusal(e, 'portal.return.options', RETURNS_COPY.requesterOptionsUnavailable);
  }
}

async function portalReadLimited(userId: string): Promise<ActionResult<never> | null> {
  const limit = await checkRateLimit(`portal-return-read:user:${userId}`, RETURN_READS_PER_USER_PER_HOUR, ONE_HOUR_MS, 'closed');
  return limit.allowed ? null : err('rate_limited', 'Too many requests. Wait a while and try again.');
}

/** A refusal in the customer's words; anything unexpected is reported and generic. */
function portalReturnRefusal(e: unknown, tag: string, fallback: string): ActionResult<never> {
  if (e instanceof ServiceError) {
    if (e.code === 'not_found' || e.code === 'module_disabled') {
      return err('not_found', 'This order could not be found.');
    }
    if (e.code === 'validation_error' || e.code === 'conflict') {
      return err(e.code, e.message, typeof e.details?.reason === 'string' ? { reason: e.details.reason } : undefined);
    }
  }
  void reportError(e, { tag });
  return err('internal_error', fallback);
}
