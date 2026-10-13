import 'server-only';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/server/services/lib/paginate';

import { embedItemsBatch, type EmbedBatchStop } from './embeddings';

/**
 * The hourly embeddings sweep (cron/embeddings-sweep, vercel.json
 * "37 * * * *"): in every organization that switched the AI module on, any
 * live item still without a search embedding is embedded by the next run
 * that reaches it, whatever left it so: at most 100 items per organization
 * and 150 per run (THE BUDGET below), so a larger backlog, a 500-row books
 * import for one, clears over several runs. The request paths embed their
 * own new rows (create, update, a size run, a duplicate, Ungroup's split);
 * the books import and bulkCreate (up to 500 rows each) do not, and a Gemini
 * failure, a call cut off or a path added later can leave a row behind. An
 * edit that changes an item's searched text clears its old embedding in the
 * same UPDATE (trigger 0401), so a re-embed that fails leaves the item here
 * too, never with a stale vector. Semantic search (the AI assistant's item
 * search) cannot find an item without one.
 *
 * ONLY ORGANIZATIONS WITH AI ON. The one reader of an embedding is the AI
 * assistant's item search (searchInventorySemantic, behind /api/ai/chat,
 * which asserts the 'ai' module), so an organization that never switched AI
 * on would have its item text sent to Gemini every hour for vectors nothing
 * in it can read. The sweep works only for the organizations whose
 * organization_modules row for 'ai' is enabled, the rule every cron follows
 * (the daily briefing reads the same rows): lib/modules/effective-modules.ts
 * keeps automation on the explicit switch, and a comp (all_modules_comp)
 * unlocks AI for members without starting this machine.
 *
 * THE BUDGET. Every number bounds time or Gemini calls:
 *   deadlineMs 150 s: no item STARTS after 150 s. The one in flight finishes
 *     within EMBED_TIMEOUT_MS (10 s) of Gemini, then its read again and its
 *     write, and its organization ends with one count query (or, when its
 *     read failed, with its error report, whose POST is capped at 2 s), so a
 *     run ends well inside the route's maxDuration of 300 s even when every
 *     call times out and Supabase stalls for seconds.
 *   runCap 150 items: an embed is about 0.2 to 0.5 s of Gemini, a read
 *     again, a write and embedItemsBatch's 50 ms pacing, so a full run
 *     normally takes about a minute. Attempts count, not successes (a
 *     failure, or an item that changed while it was embedded, counts too),
 *     so neither can make a run call Gemini more often. At most 3,600 calls
 *     a day even if every run were full; in steady state a run embeds only
 *     what the request paths missed, often nothing.
 *   Gemini failing: the run stops at Gemini's first 429 (the key's limit is
 *     reached; every further call would be refused, and the AI assistant's
 *     searches use the same key) or after GEMINI_FAILURES_IN_A_ROW (3)
 *     failed calls in a row, counted across organizations (Gemini down).
 *     The summary line says which (`stopped`).
 *   perOrgCap 100 items: one organization's backlog (a 500-row books import)
 *     cannot take a whole run while another waits; it clears over a few runs.
 *   maxOrgs 50: finding the organizations costs one read of the AI switches,
 *     then one look per organization with AI on, until 50 with a missing
 *     item are found or the deadline passes; far above the organizations
 *     that exist today.
 */
export const EMBEDDINGS_SWEEP = {
  perOrgCap: 100,
  runCap: 150,
  maxOrgs: 50,
  deadlineMs: 150_000,
} as const;

export type EmbeddingsSweepLimits = { [K in keyof typeof EMBEDDINGS_SWEEP]: number };

/** Counts, and the first failure's message: no item names or ids, no
 *  organization ids. The route logs it as the run's one summary line; an
 *  organization whose read fails is reported on its own, by reportError, with
 *  its id. */
export interface EmbeddingsSweepResult {
  /** Set when the run did nothing on purpose. */
  skipped: 'no_gemini_key' | null;
  /** Organizations with the AI module switched on: the only ones looked at. */
  aiOrgs: number;
  /** Of those, the ones found with a live item that has no embedding. */
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
  /** The run's first failed item's error message (Gemini's or the
   *  database's words, never the item's id or text), or null. */
  firstError: string | null;
  /** Set when Gemini stopped the run early: its first 429 (the key's limit,
   *  which the AI assistant's searches share), or GEMINI_FAILURES_IN_A_ROW
   *  failed calls in a row. The rest waits for the next run. */
  stopped: EmbedBatchStop | null;
  /** Gemini calls failing in a row when the run ended (3 when it stopped
   *  for that reason). */
  geminiFailuresInARow: number;
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
 * so the organization filters are the only tenant boundary: the AI switches
 * are read from organization_modules (organization ids only), each look for
 * a missing item names ONE organization with AI on and reads one item id,
 * and every item read and every write goes through embedItemsBatch with ONE
 * such organization's id, which it puts on its read, on each write (with the
 * item's id) and on its count. Only the `embedding` column is written, and
 * tg_inventory_items_set_updated_at (0242) keeps updated_at for an
 * embedding-only write, so the Items lists and their cache are untouched.
 * Reuses embedItemsBatch's batching and pacing (the Settings > AI
 * backfill's), oldest items first.
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
    aiOrgs: 0,
    orgs: 0,
    moreOrgs: false,
    orgsProcessed: 0,
    orgsFailed: 0,
    orgsLeft: 0,
    embedded: 0,
    failed: 0,
    firstError: null,
    stopped: null,
    geminiFailuresInARow: 0,
    changed: 0,
    remaining: 0,
    timeUp: false,
    ms: 0,
  };
  if (!env.GEMINI_API_KEY) return { ...result, skipped: 'no_gemini_key' };

  const aiOrgIds = await orgsWithAiOn(admin);
  result.aiOrgs = aiOrgIds.length;
  const found = await orgsMissingEmbeddings(admin, aiOrgIds, limits.maxOrgs, deadline);
  result.orgs = found.orgIds.length;
  result.moreOrgs = found.more;
  const order = rotateByHour(found.orgIds, startedAt);

  let budget = limits.runCap;
  let reached = 0;
  for (const organizationId of order) {
    if (budget <= 0 || Date.now() >= deadline) break;
    reached += 1;
    try {
      // logEachFailure false: a failed item is counted, never logged on a
      // line of its own (which would carry its id); the run keeps the first
      // failure's message for its summary. stopWhenGeminiFails: a 429, or
      // GEMINI_FAILURES_IN_A_ROW failures in a row counted across the
      // organizations (carried from batch to batch), ends the whole run.
      const batch = await embedItemsBatch(
        { supabase: admin, organizationId },
        {
          limit: Math.min(limits.perOrgCap, budget),
          deadline,
          logEachFailure: false,
          stopWhenGeminiFails: true,
          geminiFailuresInARow: result.geminiFailuresInARow,
        },
      );
      result.orgsProcessed += 1;
      result.embedded += batch.embedded;
      result.failed += batch.failed;
      result.changed += batch.changed;
      result.remaining += batch.remaining;
      result.firstError ??= batch.firstError;
      result.geminiFailuresInARow = batch.geminiFailuresInARow;
      // Attempts, not successes: each of the three called Gemini once.
      budget -= batch.embedded + batch.failed + batch.changed;
      if (batch.stopped) {
        // The key is shared by every organization: the next would fail too.
        result.stopped = batch.stopped;
        break;
      }
    } catch (err) {
      // embedItemsBatch throws only when its read of the items fails.
      // Awaited, so the alert POST is never left in flight when the run
      // returns (reportError never throws and caps its POST at 2 s).
      result.orgsFailed += 1;
      await reportError(err, {
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
 * The organizations whose 'ai' module is switched on by its own
 * organization_modules row (enabled = true), in id order: the set the daily
 * briefing reads. Never the comp (organizations.all_modules_comp): for a cron
 * the explicit switch decides (lib/modules/effective-modules.ts, AUTOMATION).
 * A failed read throws, so the run reads no item at all.
 */
async function orgsWithAiOn(admin: AdminClient): Promise<string[]> {
  try {
    const rows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'ai')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
    return rows.map((r) => r.organization_id);
  } catch (err) {
    // fetchAllRows keeps the database's words in internalDetail, behind a
    // generic message, and the route's report prints the message alone.
    const detail =
      (err as { internalDetail?: string }).internalDetail ??
      (err instanceof Error ? err.message : String(err));
    throw new Error(`embeddings sweep: could not read the AI switches: ${detail}`);
  }
}

/**
 * Of `candidates` (the organizations with AI on, in id order), the ones that
 * have a live item without an embedding, at most `maxOrgs`. One look per
 * organization, each naming that organization and asking for one item id, so
 * an organization missing thousands costs one small query; the indexes that
 * lead with organization_id serve it. No look starts after the deadline. A
 * failed look throws: the run cannot know where to go.
 */
async function orgsMissingEmbeddings(
  admin: AdminClient,
  candidates: readonly string[],
  maxOrgs: number,
  deadline: number,
): Promise<{ orgIds: string[]; more: boolean }> {
  const orgIds: string[] = [];
  for (const organizationId of candidates) {
    if (Date.now() >= deadline) return { orgIds, more: true };
    const { data, error } = await admin
      .from('inventory_items')
      .select('id')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .is('embedding', null)
      .limit(1);
    if (error) throw new Error(`embeddings sweep: could not find organizations: ${error.message}`);
    if (((data as unknown[] | null) ?? []).length === 0) continue;
    if (orgIds.length >= maxOrgs) return { orgIds, more: true };
    orgIds.push(organizationId);
  }
  return { orgIds, more: false };
}

/** `ids` starting at position (UTC hour % length), the rest after it in order. */
function rotateByHour(ids: readonly string[], now: number): string[] {
  if (ids.length === 0) return [];
  const shift = new Date(now).getUTCHours() % ids.length;
  return [...ids.slice(shift), ...ids.slice(0, shift)];
}
