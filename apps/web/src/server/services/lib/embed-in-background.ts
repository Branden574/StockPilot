import 'server-only';

import type * as Embeddings from '@/lib/ai/embeddings';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { keepAlive } from './defer';

/** Embeds in flight at once in one background loop (a size run has up to 60
 *  sizes, a SKU's records a few, an Ungroup up to 100 records). Gemini and
 *  the write each take a fraction of a second, so four keep a run short
 *  without a burst of calls. */
const BACKGROUND_EMBED_CONCURRENCY = 4;

/** The client and organization embedInventoryItem reads and writes through. */
type EmbedItemCtx = Parameters<typeof Embeddings.embedInventoryItem>[1];

/**
 * The embeddings module, imported on first use (lazy, so the Gemini SDK loads
 * only where an item is embedded) and shared by every loop after that: an
 * edit starts two loops back to back (the record, then the SKU's other
 * records). A failed import is forgotten, so the next loop tries again.
 * Sharing it also keeps tests honest: vitest 4.1 answers two CONCURRENT
 * dynamic imports of a vi.mock'ed module with the real module for one of them.
 */
let embeddingsModule: Promise<typeof Embeddings> | null = null;
function loadEmbeddings(): Promise<typeof Embeddings> {
  embeddingsModule ??= import('@/lib/ai/embeddings').catch((err: unknown) => {
    embeddingsModule = null;
    throw err;
  });
  return embeddingsModule;
}

/**
 * Embed `ids` for semantic search after the response: ONE loop over them, at
 * most BACKGROUND_EMBED_CONCURRENCY at a time, each embedInventoryItem awaited
 * inside it, the whole loop handed to keepAlive (./defer.ts, the mechanism
 * #352 added for audit rows), which keeps the invocation alive until the last
 * write settles. The caller never waits for Gemini. Call it right after the
 * rows are saved, before anything that can still throw, so a later failure
 * (a refused opening movement rolls the quantity back and throws, and the row
 * stays) cannot skip it.
 *
 * WHO CALLS IT: InventoryService.create, update (the record, then the SKU's
 * other records its fan-out rewrote), bulkCreateSizedVariants (a size run)
 * and duplicateItem, and ItemGroupingService.splitSku (the records Ungroup
 * gave a new SKU). It lives here, not in inventory.ts, so both services share
 * one copy; server/embedding-calls.guard.test.ts pins every call site.
 *
 * WHY (2026-10-13): 12 Learn4Life items had no embedding, so semantic search
 * never found them. They were size runs: bulkCreateSizedVariants never
 * embedded at all, and neither did duplicateItem (0299 says the embedding is
 * "rebuilt by their own paths"; there was none). Both call this now. create()
 * and update() had started theirs as a bare `void (async () => ...)()`, which
 * held nothing once the response was sent; handing them to keepAlive too is
 * hardening, since every item created through create() since 2026-09-28 has
 * its embedding.
 *
 * embedInventoryItem swallows and logs its own failures (Gemini, a refused
 * write); the catch here is for the loop itself (the lazy import) and logs
 * too. An item whose embed fails is left with no embedding: a new row never
 * had one, and an UPDATE that changed its searched text (an edit, the SKU
 * fan-out, Ungroup's new SKU) cleared the old one in the same statement
 * (trigger 0401). The next run of the hourly sweep (cron/embeddings-sweep)
 * embeds it, as it does the rows the books import and bulkCreate never embed
 * at once: at most 100 items per organization per run, so a larger backlog
 * clears over several runs. Writes only `embedding`, which the list cache
 * does not need to know about (tg_inventory_items_set_updated_at keeps
 * updated_at for an embedding-only write, 0242).
 *
 * NOT YET: these request-path embeds run for every organization, AI module
 * on or not; the sweep works only for organizations that switched AI on.
 * Gating these on the module too is a follow-up.
 */
export function embedInBackground(
  ids: readonly string[],
  ctx: { supabase: unknown; organizationId: string },
): void {
  if (ids.length === 0) return;
  keepAlive(
    (async () => {
      const { embedInventoryItem } = await loadEmbeddings();
      await mapWithConcurrency(ids, BACKGROUND_EMBED_CONCURRENCY, async (id) => {
        await embedInventoryItem(id, ctx as EmbedItemCtx);
      });
    })().catch((err: unknown) => {
      console.warn('[embeddings] background embed failed:', err);
    }),
  );
}
