import 'server-only';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';

import { embedItemsBatch } from './embeddings';

/**
 * The hourly embeddings sweep (cron/embeddings-sweep, vercel.json
 * "37 * * * *"): any live item still without a search embedding is embedded
 * by the next run that reaches it, whatever left it so: at most 100 items per
 * organization and 150 per run (THE BUDGET below), so a larger backlog, a
 * 500-row books import for one, clears over several runs. The request paths
 * embed their own new rows (create, update, a size run, a duplicate); the
 * books import and bulkCreate (up to 500 rows each) do not, and a Gemini
 * failure, a call cut off or a path added later can leave a row behind. An
 * edit that changes an item's searched text clears its old embedding in the
 * same UPDATE (trigger 0401), so a re-embed that fails, or one that never
 * starts (Ungroup's split_item_sku), leaves the item here too, never with a
 * stale vector. Semantic search (the AI assistant's item search) cannot find
 * an item without one.
 *
 * THE BUDGET. Every number bounds time or Gemini calls:
 *   deadlineMs 150 s: no item STARTS after 150 s. The one in flight finishes
 *     within EMBED_TIMEOUT_MS (10 s) of Gemini, then its read again and its
 *     write, and its organization ends with one count query, so a run ends
 *     well inside the route's maxDuration of 300 s even when every call times
 *     out and Supabase stalls for seconds.
 *   runCap 150 items: an embed is about 0.2 to 0.5 s of Gemini, a read
 *     again, a write and embedItemsBatch's 50 ms pacing, so a full run
 *     normally takes about a minute. Attempts count, not successes (a
 *     failure, or an item that changed while it was embedded, counts too),
 *     so neither can make a run call Gemini more often. At most 3,600 calls
 *     a day even if every run were full; in steady state a run embeds only
 *     what the request paths missed, often nothing.
 *   perOrgCap 100 items: one organization's backlog (a 500-row books import)
 *     cannot take a whole run while another waits; it clears over a few runs.
 *   maxOrgs 50: finding the organizations costs one query each; far above
 *     the organizations that exist today.
 */
export const EMBEDDINGS_SWEEP = {
  perOrgCap: 100,
  runCap: 150,
  maxOrgs: 50,
  deadlineMs: 150_000,
} as const;

export type EmbeddingsSweepLimits = { [K in keyof typeof EMBEDDINGS_SWEEP]: number };

/** Counts only: no item names, no organization ids. The route logs it as the
 *  run's one summary line; an organization whose read fails is reported on
 *  its own, by reportError, with its id. */
export interface EmbeddingsSweepResult {
  /** Set when the run did nothing on purpose. */
  skipped: 'no_gemini_key' | null;
  /** Organizations found with a live item that has no embedding. */
  orgs: number;
  /** The search for organizations stopped at maxOrgs or the deadline. */
  moreOrgs: boolean;
  orgsProcessed: number;
  /** Organizations whose batch could not even read its items (reported). */
  orgsFailed: number;
  /** Found, but not reached this run (run cap or deadline). */
  orgsLeft: number;
  embedded: number;
  /** Items whose embed or write failed: still missing, for the next run. */
  failed: number;
  /** Items that changed while they were embedded (an edit, or a vector
   *  another path wrote): nothing was written over them. One still missing
   *  is embedded from its current text by the next run. */
  changed: number;
  /** Items still missing, in the organizations processed. */
  remaining: number;
  timeUp: boolean;
  ms: number;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * One run of the sweep, on the SERVICE-ROLE client. RLS does not apply to it,
 * so the organization filters are the only tenant boundary: the search for
 * organizations reads only `organization_id`, and every item read and every
 * write goes through embedItemsBatch with ONE organization's id, which it
 * puts on its read, on each write (with the item's id) and on its count. Only
 * the `embedding` column is written, and tg_inventory_items_set_updated_at
 * (0242) keeps updated_at for an embedding-only write, so the Items lists
 * and their cache are untouched. Reuses embedItemsBatch's batching and
 * pacing (the Settings > AI backfill's), oldest items first.
 *
 * Fair over time: organizations are taken in id order, rotated by the UTC
 * hour, so when the run cap stops a run, a different organization goes first
 * in the next one. One organization's failure is reported (reportError, with
 * that organization's id: the only place a run names one) and the rest carry
 * on. Without a Gemini key it reads nothing.
 */
export async function sweepMissingEmbeddings(
  admin: AdminClient,
  limits: EmbeddingsSweepLimits = EMBEDDINGS_SWEEP,
): Promise<EmbeddingsSweepResult> {
  const startedAt = Date.now();
  const deadline = startedAt + limits.deadlineMs;
  const result: EmbeddingsSweepResult = {
    skipped: null,
    orgs: 0,
    moreOrgs: false,
    orgsProcessed: 0,
    orgsFailed: 0,
    orgsLeft: 0,
    embedded: 0,
    failed: 0,
    changed: 0,
    remaining: 0,
    timeUp: false,
    ms: 0,
  };
  if (!env.GEMINI_API_KEY) return { ...result, skipped: 'no_gemini_key' };

  const found = await orgsMissingEmbeddings(admin, limits.maxOrgs, deadline);
  result.orgs = found.orgIds.length;
  result.moreOrgs = found.more;
  const order = rotateByHour(found.orgIds, startedAt);

  let budget = limits.runCap;
  let reached = 0;
  for (const organizationId of order) {
    if (budget <= 0 || Date.now() >= deadline) break;
    reached += 1;
    try {
      const batch = await embedItemsBatch(
        { supabase: admin, organizationId },
        { limit: Math.min(limits.perOrgCap, budget), deadline },
      );
      result.orgsProcessed += 1;
      result.embedded += batch.embedded;
      result.failed += batch.failed;
      result.changed += batch.changed;
      result.remaining += batch.remaining;
      // Attempts, not successes: each of the three called Gemini once.
      budget -= batch.embedded + batch.failed + batch.changed;
    } catch (err) {
      // embedItemsBatch throws only when its read of the items fails.
      result.orgsFailed += 1;
      void reportError(err, {
        tag: 'cron.embeddings-sweep.org',
        level: 'warning',
        organizationId,
      });
    }
  }
  result.orgsLeft = order.length - reached;
  result.timeUp = Date.now() >= deadline;
  result.ms = Date.now() - startedAt;
  return result;
}

/**
 * The organizations that have a live item without an embedding, in id
 * order, at most `maxOrgs`. One query per organization found, each asking
 * for the first such item after the last organization found, so an
 * organization missing thousands costs one query, not a page of rows; the
 * indexes that lead with organization_id serve the order. A failed read
 * throws: the run cannot know where to go.
 */
async function orgsMissingEmbeddings(
  admin: AdminClient,
  maxOrgs: number,
  deadline: number,
): Promise<{ orgIds: string[]; more: boolean }> {
  const orgIds: string[] = [];
  let after: string | null = null;
  while (Date.now() < deadline) {
    let query = admin
      .from('inventory_items')
      .select('organization_id')
      .is('deleted_at', null)
      .is('embedding', null);
    if (after !== null) query = query.gt('organization_id', after);
    const { data, error } = await query.order('organization_id', { ascending: true }).limit(1);
    if (error) throw new Error(`embeddings sweep: could not find organizations: ${error.message}`);
    const next = (data as Array<{ organization_id: string }> | null)?.[0]?.organization_id;
    if (!next) return { orgIds, more: false };
    if (orgIds.length >= maxOrgs) return { orgIds, more: true };
    orgIds.push(next);
    after = next;
  }
  return { orgIds, more: true };
}

/** `ids` starting at position (UTC hour % length), the rest after it in order. */
function rotateByHour(ids: readonly string[], now: number): string[] {
  if (ids.length === 0) return [];
  const shift = new Date(now).getUTCHours() % ids.length;
  return [...ids.slice(shift), ...ids.slice(0, shift)];
}
