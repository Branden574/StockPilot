'use server';

import { z } from 'zod';

import { rethrowControlFlow } from '@/lib/control-flow';
import { BillingService } from '@/server/services/billing';
import { actionErrorResult } from '@/server/lib/action-error-result';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  rethrowControlFlow(error);
  return actionErrorResult(error, 'actions.billing');
}

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'business']),
  interval: z.enum(['monthly', 'yearly']),
});

export async function createCheckoutSessionAction(input: z.infer<typeof checkoutSchema>): Promise<ActionResult<{ url: string }>> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid plan');
  try {
    const svc = await BillingService.forCurrentUser();
    const { url } = await svc.createCheckoutSession(parsed.data.plan, parsed.data.interval);
    return ok({ url });
  } catch (e) {
    return toResult(e);
  }
}

export async function createPortalSessionAction(): Promise<ActionResult<{ url: string }>> {
  try {
    const svc = await BillingService.forCurrentUser();
    const { url } = await svc.createPortalSession();
    return ok({ url });
  } catch (e) {
    return toResult(e);
  }
}
