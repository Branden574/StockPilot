import 'server-only';

import { GoogleGenerativeAI } from '@google/generative-ai';

import { env } from '@/lib/env';

/**
 * Embedding model + dimension. We use Gemini's gemini-embedding-001 at
 * outputDimensionality=1536 to match the `inventory_items.embedding`
 * column type (vector(1536)) that was scaffolded in migration 0002.
 *
 * If you change the model or dimension, you must:
 *   1. ALTER the column to the new dim (Postgres requires a full
 *      rewrite, so do it via a migration with `using null::vector(N)`
 *      and re-run the backfill).
 *   2. Re-embed every row — old vectors are unusable across models.
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIM = 1536;

/**
 * Builds the text we feed into the embedding model for an inventory item.
 * Keep it deterministic and pure so two identical items produce the same
 * vector. Order matters less than coverage — include the name, SKU,
 * barcode (so ISBN lookups land near the title), description, and a
 * couple custom_fields that carry meaningful info (author for books).
 */
export function itemEmbeddingSource(item: {
  name: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  custom_fields?: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];
  if (item.name?.trim()) parts.push(item.name.trim());
  if (item.sku?.trim()) parts.push(`SKU ${item.sku.trim()}`);
  if (item.barcode?.trim()) parts.push(`Barcode ${item.barcode.trim()}`);
  if (item.description?.trim()) parts.push(item.description.trim());
  const cf = item.custom_fields ?? {};
  if (typeof cf.author === 'string' && cf.author.trim()) {
    parts.push(`Author ${cf.author.trim()}`);
  }
  return parts.join(' · ').slice(0, 4000); // bounded so a 50KB description doesn't blow the model
}

/**
 * Embeds a single text into a 1536-dim vector via Gemini. Caller is
 * responsible for handling the throw — errors here usually mean the
 * upstream model is down or the API key is missing, both of which
 * are recoverable (skip this embed, try again later).
 */
export async function embedText(text: string): Promise<number[]> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Embeddings require the same key used for chat.',
    );
  }
  if (!text || !text.trim()) {
    throw new Error('embedText: empty input');
  }
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  // `outputDimensionality` is supported by gemini-embedding-001 and lets
  // us match the existing 1536-wide column. The SDK passes it through
  // verbatim. `taskType: RETRIEVAL_DOCUMENT` for the row side, callers
  // should use RETRIEVAL_QUERY when embedding the user's question.
  const res = await model.embedContent({
    content: { role: 'user', parts: [{ text }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputDimensionality: EMBEDDING_DIM,
    taskType: 'RETRIEVAL_DOCUMENT',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const vec = res.embedding?.values;
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedText: unexpected vector shape (got length ${vec?.length}, want ${EMBEDDING_DIM})`,
    );
  }
  return vec;
}

/**
 * Same as embedText but uses the query-side task type. Use this when
 * embedding the user's search input (the "?" side of a retrieval),
 * not the indexed documents.
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set.');
  }
  if (!text || !text.trim()) {
    throw new Error('embedQuery: empty input');
  }
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const res = await model.embedContent({
    content: { role: 'user', parts: [{ text }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputDimensionality: EMBEDDING_DIM,
    taskType: 'RETRIEVAL_QUERY',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  const vec = res.embedding?.values;
  if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `embedQuery: unexpected vector shape (got length ${vec?.length}, want ${EMBEDDING_DIM})`,
    );
  }
  return vec;
}

/**
 * Format a JS number[] as the Postgres `vector` literal Supabase expects
 * when passing through `.rpc()` / `.update()`. pgvector accepts
 * '[1.0,2.0,3.0,...]'.
 */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/**
 * Best-effort: embed an item's metadata and write the vector back to
 * its `embedding` column. Failures are SWALLOWED — semantic search is
 * a nice-to-have, never block create/update on a Gemini hiccup.
 *
 * Designed to be called fire-and-forget from InventoryService.create
 * and update via `void embedInventoryItem(...)`.
 */
export async function embedInventoryItem(
  itemId: string,
  ctx: {
    supabase: {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              maybeSingle: () => Promise<{
                data: Record<string, unknown> | null;
                error: unknown;
              }>;
            };
          };
        };
        update: (patch: Record<string, unknown>) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => Promise<{ error: unknown }>;
          };
        };
      };
    };
    organizationId: string;
  },
): Promise<void> {
  try {
    const { data: row } = await ctx.supabase
      .from('inventory_items')
      .select('id, name, sku, barcode, description, custom_fields')
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (!row) return;
    const source = itemEmbeddingSource(
      row as {
        name: string | null;
        sku?: string | null;
        barcode?: string | null;
        description?: string | null;
        custom_fields?: Record<string, unknown> | null;
      },
    );
    if (!source) return;
    const vec = await embedText(source);
    await ctx.supabase
      .from('inventory_items')
      .update({ embedding: vectorLiteral(vec) })
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[embeddings] item embed failed:', err);
  }
}

/**
 * Embeds up to `limit` un-embedded items in the caller's org. Shared
 * by the admin-only server action and the AI tool so both paths use
 * identical batching + pacing.
 *
 * `remaining` is the count of items still without an embedding AFTER
 * this batch finishes, so a UI can show "X of Y done" by computing
 * (Y - remaining).
 */
export async function embedItemsBatch(
  // Keep the type loose so this stays compatible with both the
  // service-context shape and the cached withContext() result.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { supabase: any; organizationId: string },
  opts: { limit?: number } = {},
): Promise<{ embedded: number; failed: number; remaining: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));

  const { data: rows, error: loadErr } = await ctx.supabase
    .from('inventory_items')
    .select('id, name, sku, barcode, description, custom_fields')
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (loadErr) throw new Error(loadErr.message);

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
        console.warn('[embedItemsBatch] write failed:', row.id, updateErr.message);
        continue;
      }
      embedded += 1;
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.warn('[embedItemsBatch] embed failed:', row.id, e);
    }
    // Light pacing to stay below Gemini's burst limit on tier 0.
    await new Promise((r) => setTimeout(r, 50));
  }

  const { count: totalRemaining } = await ctx.supabase
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .is('embedding', null);

  return { embedded, failed, remaining: totalRemaining ?? 0 };
}
