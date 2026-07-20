'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolvePortalContext, portalSubmitOrder, type PortalSubmitInput } from '@/server/services/portal';
import { createPortalReturn } from '@/server/services/returns';
import { ServiceError } from '@/server/services/context';

import { err, ok, type ActionResult } from '@stockpilot/core';

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
      }),
    )
    .min(1)
    .max(100),
});

export type PortalReturnInput = z.input<typeof portalReturnSchema>;

/**
 * Mirrors the public token surface's per-principal cap (10/hr, fail-CLOSED —
 * global constraint for portal/public surfaces: a limiter outage denies
 * rather than opening the floodgates). A legitimate customer files a handful
 * of returns, not dozens per hour.
 */
const RETURN_RATE_LIMIT_PER_USER_PER_HOUR = 10;
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
 */
export async function requestPortalReturnAction(
  input: PortalReturnInput,
): Promise<ActionResult<{ id: string; status: 'requested' }>> {
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
      },
      {
        reasonCode: parsed.data.reasonCode,
        notes: parsed.data.notes || undefined,
        lines: parsed.data.lines,
      },
    );
    revalidatePath('/portal');
    return ok({ id: created.id, status: 'requested' as const });
  } catch (e) {
    if (e instanceof ServiceError) {
      if (e.code === 'not_found') {
        return err('not_found', 'This order could not be found.');
      }
      if (e.code === 'validation_error') {
        return err('validation_error', e.message);
      }
    }
    void reportError(e, { tag: 'portal.return.create' });
    return err('internal_error', 'Your return request could not be submitted. Please try again.');
  }
}
