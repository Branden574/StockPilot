'use server';

import { isAdminRole } from '@stockpilot/core';
import { err, ok, type ActionResult } from '@stockpilot/core';

import { embedText, itemEmbeddingSource, vectorLiteral } from '@/lib/ai/embeddings';
import { withContext } from '@/server/services/context';

/**
 * Backfills `inventory_items.embedding` for items that don't have one
 * yet. Admin-only. Processes up to `limit` items per invocation
 * (default 50, max 200) — call repeatedly until `remaining` is 0.
 *
 * Each item costs one Gemini embedContent call. At Gemini's pricing
 * tier 0 (free) the cap is ~1500 RPM, so a 5000-item org takes a
 * few minutes spread across calls. We sleep 50ms between embeds so
 * we don't burst above the rate limit.
 */
export async function backfillItemEmbeddingsAction(
  input: { limit?: number } = {},
): Promise<ActionResult<{ embedded: number; failed: number; remaining: number }>> {
  const ctx = await withContext();
  if (!isAdminRole(ctx.role)) {
    return err('forbidden', 'Admin role required to run the embedding backfill.');
  }

  const limit = Math.min(200, Math.max(1, input.limit ?? 50));

  // Pick the oldest un-embedded items first so concurrent runs converge.
  const { data: rows, error: loadErr } = await ctx.supabase
    .from('inventory_items')
    .select('id, name, sku, barcode, description, custom_fields')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (loadErr) return err('internal_error', loadErr.message);

  // Count how many remain after this batch for the UI progress bar.
  const { count: totalRemaining } = await ctx.supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .is('embedding', null);

  let embedded = 0;
  let failed = 0;
  for (const row of (rows ?? []) as Array<{
    id: string;
    name: string | null;
    sku?: string | null;
    barcode?: string | null;
    description?: string | null;
    custom_fields?: Record<string, unknown> | null;
  }>) {
    const source = itemEmbeddingSource(row);
    if (!source) {
      failed += 1;
      continue;
    }
    try {
      const vec = await embedText(source);
      const { error: updateErr } = await ctx.supabase
        .from('inventory_items')
        .update({ embedding: vectorLiteral(vec) })
        .eq('organization_id', ctx.organizationId)
        .eq('id', row.id);
      if (updateErr) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn('[embeddings backfill] write failed:', row.id, updateErr.message);
        continue;
      }
      embedded += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn('[embeddings backfill] embed failed:', row.id, e);
    }
    // Light pacing to stay below Gemini's burst limit on tier 0.
    await new Promise((r) => setTimeout(r, 50));
  }

  const remaining = Math.max(0, (totalRemaining ?? 0) - embedded);
  return ok({ embedded, failed, remaining });
}
