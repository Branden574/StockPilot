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
 * How long one embedding call to Gemini may take, in milliseconds, before the
 * SDK aborts it. The SDK sets no deadline of its own, so a call that never
 * answered held its invocation open for as long as the platform allowed: the
 * whole keepAlive window after a create, or a cron run's whole budget. A call
 * normally answers in well under a second. The SDK applies the `timeout`
 * request option by aborting the fetch (GoogleGenerativeAIAbortError), which
 * every caller already treats as one more failed embed. The item is then left
 * with no embedding: a new item never had one, and an edit that changed the
 * text cleared the old one in the same UPDATE (trigger 0401). The next run of
 * the hourly sweep (cron/embeddings-sweep) embeds it, at most 100 items per
 * organization per run, so a larger backlog clears over several runs.
 */
export const EMBED_TIMEOUT_MS = 10_000;

/**
 * Embeds a single text into a 1536-dim vector via Gemini. Caller is
 * responsible for handling the throw — errors here usually mean the
 * upstream model is down or the API key is missing, both of which
 * are recoverable (skip this embed, try again later). A call that takes
 * longer than EMBED_TIMEOUT_MS throws too.
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
  const res = await model.embedContent(
    {
      content: { role: 'user', parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIM,
      taskType: 'RETRIEVAL_DOCUMENT',
    } as any,
    { timeout: EMBED_TIMEOUT_MS },
  );
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
     
    outputDimensionality: EMBEDDING_DIM,
    taskType: 'RETRIEVAL_QUERY',
     
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
 * The client and organization an item's embedding is read and written
 * through. Typed loosely, as embedItemsBatch's always was: callers pass the
 * service context's client, the service-role client or a cached
 * withContext() result, and every chain below is PostgREST's own.
 */
type EmbedCtx = { supabase: any; organizationId: string };

/** The columns an item's embedding text is built from (itemEmbeddingSource). */
const EMBED_SOURCE_COLUMNS = 'id, name, sku, barcode, description, custom_fields';

type EmbedSourceRow = {
  id: string;
  name: string | null;
  sku?: string | null;
  barcode?: string | null;
  description?: string | null;
  custom_fields?: Record<string, unknown> | null;
};

/** What writeIfStillCurrent did: wrote the vector, or wrote nothing because
 *  the item changed meanwhile (`written: false`), or could not read or write. */
type EmbedWrite = { written: boolean } | { failed: 'read' | 'write'; message: string };

/**
 * Writes `vec`, built from `source`, to the item only while the item still
 * has that text. A Gemini call takes a moment and the item can be edited
 * meanwhile; a vector written over the newer text would describe the old text
 * from then on. So the item is read again right before the write, the write
 * goes ahead only when that read builds the same text, and the UPDATE is
 * guarded by that read's updated_at: tg_inventory_items_set_updated_at (0242,
 * restated in 0303) moves updated_at with every real change to the row and
 * keeps it for an embedding-only write, so an edit that lands between the
 * read and the write leaves the UPDATE matching no row.
 *
 * Read again, rather than guarded by the first read's updated_at: a stock
 * movement moves updated_at too, and the create paths write the opening
 * movement right after starting the embed, so that guard would drop most of
 * their embeds although the text never changed.
 *
 * `onlyIfMissing` (embedItemsBatch) also writes only while the item has no
 * embedding, so a vector another path wrote meanwhile (an edit's own
 * re-embed, the Settings > AI backfill) is never replaced.
 *
 * `{ written: false }` leaves the item to the path that changed it: an edit
 * re-embeds what it saved, and an item still without an embedding waits for
 * the next sweep.
 */
async function writeIfStillCurrent(
  ctx: EmbedCtx,
  itemId: string,
  source: string,
  vec: number[],
  opts: { onlyIfMissing: boolean },
): Promise<EmbedWrite> {
  const { data: current, error: readErr } = await ctx.supabase
    .from('inventory_items')
    .select(`${EMBED_SOURCE_COLUMNS}, updated_at`)
    .eq('organization_id', ctx.organizationId)
    .eq('id', itemId)
    .maybeSingle();
  if (readErr) return { failed: 'read', message: errorText(readErr) };
  if (!current || itemEmbeddingSource(current as EmbedSourceRow) !== source) {
    return { written: false };
  }
  let write = ctx.supabase
    .from('inventory_items')
    .update({ embedding: vectorLiteral(vec) })
    .eq('organization_id', ctx.organizationId)
    .eq('id', itemId)
    .eq('updated_at', (current as { updated_at: string }).updated_at);
  if (opts.onlyIfMissing) write = write.is('embedding', null);
  const { data: written, error: writeErr } = await write.select('id');
  if (writeErr) return { failed: 'write', message: errorText(writeErr) };
  return { written: Array.isArray(written) && written.length > 0 };
}

/**
 * Best-effort: embed an item's metadata and write the vector back to
 * its `embedding` column. Failures are SWALLOWED — semantic search is
 * a nice-to-have, never block create/update on a Gemini hiccup.
 *
 * InventoryService starts it without waiting, for the rows it has just
 * saved (create, update, a size run, a duplicate), in one bounded loop
 * handed to keepAlive (server/services/lib/defer.ts): the response is not
 * delayed and the write is not cut off when the instance is suspended.
 *
 * The vector is written only while the item still has the text it was built
 * from (writeIfStillCurrent): of two quick edits, the first one's embed can
 * finish last, and it must not put the first edit's text back in place of
 * the second's.
 */
export async function embedInventoryItem(itemId: string, ctx: EmbedCtx): Promise<void> {
  try {
    const { data: row, error: readErr } = await ctx.supabase
      .from('inventory_items')
      .select(EMBED_SOURCE_COLUMNS)
      .eq('organization_id', ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (readErr) {
      console.warn('[embeddings] item embed read failed:', itemId, errorText(readErr));
      return;
    }
    if (!row) return;
    const source = itemEmbeddingSource(row as EmbedSourceRow);
    if (!source) return;
    const vec = await embedText(source);
    // Every { error } is read, as embedItemsBatch does: a refused write was
    // once the one failure here that left no trace at all.
    const write = await writeIfStillCurrent(ctx, itemId, source, vec, { onlyIfMissing: false });
    if ('failed' in write) {
      console.warn(`[embeddings] item embed ${write.failed} failed:`, itemId, write.message);
    } else if (!write.written) {
      console.info('[embeddings] item changed while it was embedded; nothing written:', itemId);
    }
  } catch (err) {
    console.warn('[embeddings] item embed failed:', err);
  }
}

/** A PostgREST error's message, or the value as text. */
function errorText(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * Embeds up to `limit` un-embedded items in the caller's org. Shared
 * by the admin-only server action, the AI tool and the hourly sweep
 * (lib/ai/embeddings-sweep.ts) so every path uses identical batching +
 * pacing.
 *
 * `deadline` (a Date.now() value) stops it STARTING another item once it
 * has passed; the item in flight finishes (at most EMBED_TIMEOUT_MS of
 * Gemini, then its read again and its write). The sweep uses it so one
 * org's batch cannot run a cron invocation past its budget. Items skipped
 * for time stay missing and are counted in `remaining`.
 *
 * Each vector is written only while its item still has the text it was
 * built from and still has no embedding (writeIfStillCurrent). `changed`
 * counts the items that changed while they were embedded (an edit, or a
 * vector another path wrote): nothing was written over them, and one still
 * without an embedding is in `remaining` for the next batch.
 *
 * `remaining` is the count of items still without an embedding AFTER
 * this batch finishes, so a UI can show "X of Y done" by computing
 * (Y - remaining).
 */
export async function embedItemsBatch(
  // Keep the type loose so this stays compatible with both the
  // service-context shape and the cached withContext() result.
  ctx: EmbedCtx,
  opts: { limit?: number; deadline?: number } = {},
): Promise<{ embedded: number; failed: number; changed: number; remaining: number }> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));

  const { data: rows, error: loadErr } = await ctx.supabase
    .from('inventory_items')
    .select(EMBED_SOURCE_COLUMNS)
    .eq('organization_id', ctx.organizationId)
    .is('deleted_at', null)
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (loadErr) throw new Error(loadErr.message);

  let embedded = 0;
  let failed = 0;
  let changed = 0;
  for (const row of (rows ?? []) as EmbedSourceRow[]) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
    const source = itemEmbeddingSource(row);
    if (!source) {
      failed += 1;
      continue;
    }
    try {
      const vec = await embedText(source);
      const write = await writeIfStillCurrent(ctx, row.id, source, vec, { onlyIfMissing: true });
      if ('failed' in write) {
        failed += 1;
        console.warn(`[embedItemsBatch] ${write.failed} failed:`, row.id, write.message);
        continue;
      }
      if (write.written) embedded += 1;
      else changed += 1;
    } catch (e) {
      failed += 1;
       
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

  return { embedded, failed, changed, remaining: totalRemaining ?? 0 };
}
