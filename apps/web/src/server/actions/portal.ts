'use server';

import { revalidatePath } from 'next/cache';

import { resolvePortalContext, portalSubmitOrder, type PortalSubmitInput } from '@/server/services/portal';

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
