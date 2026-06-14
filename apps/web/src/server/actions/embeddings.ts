'use server';

import { isAdminRole } from '@stockpilot/core';
import { err, ok, type ActionResult } from '@stockpilot/core';

import { embedItemsBatch } from '@/lib/ai/embeddings';
import { withContext } from '@/server/services/context';

/**
 * Embeds the oldest un-embedded items in the org. Admin-only. Returns
 * counts so a UI loop can drive a progress bar — call repeatedly
 * until `remaining` is 0.
 */
export async function backfillItemEmbeddingsAction(
  input: { limit?: number } = {},
): Promise<ActionResult<{ embedded: number; failed: number; remaining: number }>> {
  const ctx = await withContext();
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return err(
      'forbidden',
      'Multi-factor authentication required. Enroll in MFA before performing this action.',
    );
  }
  if (!isAdminRole(ctx.role)) {
    return err('forbidden', 'Admin role required to run the embedding backfill.');
  }
  try {
    const result = await embedItemsBatch(ctx, { limit: input.limit });
    return ok(result);
  } catch (e) {
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}

/**
 * Returns the count of inventory items still missing an embedding so a
 * UI can show "Y items to backfill" before the user starts the loop.
 */
export async function getMissingEmbeddingsCountAction(): Promise<
  ActionResult<{ remaining: number; total: number }>
> {
  const ctx = await withContext();
  if (!isAdminRole(ctx.role)) {
    return err('forbidden', 'Admin role required.');
  }
  const [remainingRes, totalRes] = await Promise.all([
    ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .is('embedding', null),
    ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null),
  ]);
  return ok({
    remaining: remainingRes.count ?? 0,
    total: totalRes.count ?? 0,
  });
}
