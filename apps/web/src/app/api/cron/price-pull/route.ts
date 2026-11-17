import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { googleBooksClient } from '@/server/pricing/google-books-client';
import { DAILY_CLAIM_HOLD_MS, sweepOrganizations } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { refreshBookPricesForOrg } from '@/server/services/price-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Constant-time string compare. Copied from cron/drain-outbox.
 */
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The job's cadence: the slot of the fallback order (rotateByClock). */
const DAY_MS = 24 * 60 * 60_000;
/** How many of an organization's books one refresh reads (its window); how
 *  many it may look up is its share (maxLookups). */
const READ_WINDOW = 300;
/**
 * The most Google Books lookups one run makes, across ALL organizations: the
 * quota guard. A lookup is counted whether or not it gives a price, so every
 * price written is also under it.
 *
 * 200 (was 500 written prices) to leave headroom in the Google Books daily
 * quota (~1,000 queries/day/project) for INTERACTIVE scans/imports: price
 * pulls and metadata lookups share the same key, and a 500-call pull at 9am
 * used to starve scanning for the rest of the day. Metadata lookups are
 * cached (book_metadata_cache, 0262), price observations cannot be.
 */
const LOOKUP_CAP = 200;
/** Stop starting lookups after this long: headroom under maxDuration=60. */
const RUN_DEADLINE_MS = 50_000;

/**
 * Daily Google Books price pull for every org with the price_tracking module enabled.
 *
 * FAIR SHARE of the run's LOOKUP_CAP lookups, and of its time. The
 * organizations go least recently reached first (cron_sweep_attempts, job
 * 'price_pull'). In round one each is offered an equal part of the lookups
 * left, ceil(left / organizations not yet offered), and an equal part of the
 * time left, so neither the first organization with a big backlog nor the
 * deadline decides who gets the run. What a small organization does not use
 * then goes round again to the ones that used all of their share or of their
 * time (round-robin), until the lookups, the deadline or the backlogs run out.
 * An organization the run did not reach is not stamped, so it goes first
 * tomorrow. A book whose lookup gives no price is stamped too
 * (refreshBookPricesForOrg), so unpriceable books go to the back of the
 * organization's line instead of being asked for again every day.
 *
 * ONE RUN PER ORGANIZATION PER 20 HOURS. Each organization is claimed as it
 * starts (DAILY_CLAIM_HOLD_MS): a second delivery of the tick, or a manual
 * run, does nothing for an organization another run started in the last 20
 * hours, including one that failed (it waits for the next day's run), and a
 * manual run late in the day makes the next morning's run skip the
 * organizations it started. Each run keeps its own LOOKUP_CAP, so a tick
 * delivered twice can still spend up to twice the cap in total, split between
 * the organizations each run claimed; no book is looked up by both.
 *
 * GOOGLE NOT ANSWERING. A rate limit (429), another error reply or no reply
 * is not "no price found": the refresh stops at that book, leaves it and the
 * ones after it as they were (not stamped), and the run asks Google nothing
 * more (it would only meet the same limit). Reported once per run
 * (cron.price-pull.google); the books not reached go first next time.
 */
export async function GET(req: Request) {
  // Fail-closed when CRON_SECRET is unset/empty. Matches cron/drain-outbox.
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // The deadline counts from here, before the organization list is read.
  const startedAt = Date.now();
  const deadlineMs = startedAt + RUN_DEADLINE_MS;
  const admin = createAdminClient();
  let rows: Array<{ organization_id: string }>;
  try {
    // PAGINATED: a plain select is silently capped at PostgREST's 1000-row max,
    // skipping orgs once >1000 have price_tracking enabled (every peer cron
    // paginates this). Stable order for range pagination; fetchAllRows throws on
    // error (fail-closed).
    rows = await fetchAllRows<{ organization_id: string }>((from, to) =>
      admin
        .from('organization_modules')
        .select('organization_id')
        .eq('module_id', 'price_tracking')
        .eq('enabled', true)
        .order('organization_id', { ascending: true })
        .range(from, to),
    );
  } catch (error) {
    void reportError(new Error(`price-pull org list: ${(error as Error).message}`), {
      tag: 'cron.price-pull',
    });
    return NextResponse.json({ error: 'org_list_failed' }, { status: 500 });
  }

  const orgIds = Array.from(new Set(rows.map((r) => r.organization_id)));

  let used = 0; // lookups this run
  let written = 0;
  /** Set when Google did not answer: no more lookups this run. */
  let googleUnavailable = false;
  const left = () => LOOKUP_CAP - used;
  /** Per organization, summed over the rounds (the response's results). */
  const byOrg = new Map<
    string,
    { orgId: string; scanned: number; written: number; skipped: number; lookups: number }
  >();
  /** Per organization, the books looked up this run (not asked for again). */
  const triedByOrg = new Map<string, Set<string>>();
  /** One refresh of one organization with this share of lookups, until
   *  `until`; true when it used the whole share or its time (it may have more
   *  to price). Throws on a failed refresh. */
  const refresh = async (orgId: string, share: number, until: number): Promise<boolean> => {
    const tried = triedByOrg.get(orgId) ?? new Set<string>();
    triedByOrg.set(orgId, tried);
    const r = await refreshBookPricesForOrg(admin, orgId, googleBooksClient, {
      limit: READ_WINDOW,
      maxLookups: share,
      deadlineMs: until,
      tried,
    });
    used += r.lookups;
    written += r.written;
    if (r.googleUnavailable && !googleUnavailable) {
      googleUnavailable = true;
      void reportError(
        new Error('Google Books did not answer; the price pull stopped its lookups'),
        {
          tag: 'cron.price-pull.google',
          level: 'warning',
        },
      );
    }
    const sum = byOrg.get(orgId) ?? {
      orgId,
      scanned: 0,
      written: 0,
      skipped: 0,
      lookups: 0,
    };
    sum.scanned += r.scanned;
    sum.written += r.written;
    sum.skipped += r.skipped;
    sum.lookups += r.lookups;
    byOrg.set(orgId, sum);
    // last_priced_at stamps bump updated_at → page-1 order changes.
    if (r.lookups > 0) revalidateInventoryList(orgId);
    return !googleUnavailable && (r.lookups >= share || Date.now() > until);
  };

  // Round one: every organization, least recently reached first, each claimed
  // as it starts and offered an equal part of the lookups and of the time
  // left.
  let wantMore: string[] = [];
  const sweep = await sweepOrganizations(
    admin,
    {
      job: 'price_pull',
      tag: 'cron.price-pull',
      orgIds,
      deadlineAt: deadlineMs,
      slotMs: DAY_MS,
      holdMs: DAILY_CLAIM_HOLD_MS,
      stopWhen: () => left() <= 0 || googleUnavailable,
    },
    async (orgId, index): Promise<{ result: 'success' | 'failure'; value: null }> => {
      try {
        const others = orgIds.length - index;
        const share = Math.ceil(left() / others);
        const until = Math.min(deadlineMs, Date.now() + (deadlineMs - Date.now()) / others);
        if (await refresh(orgId, share, until)) {
          wantMore.push(orgId);
        }
        return { result: 'success', value: null };
      } catch (e) {
        // FAIL-OPEN per org: report and continue; one org must not 500 the cron.
        void reportError(e, { tag: 'cron.price-pull', extra: { orgId } });
        return { result: 'failure', value: null };
      }
    },
  );

  // Later rounds: what the small organizations left goes round again to the
  // ones that used all of their share or time (this run's claims are already
  // theirs), in the same order, equal parts of the lookups again, sharing the
  // run's deadline, until the lookups, the deadline or the backlogs run out.
  let rounds = 1;
  while (wantMore.length > 0 && left() > 0 && !googleUnavailable && Date.now() < deadlineMs) {
    rounds += 1;
    const next: string[] = [];
    for (let i = 0; i < wantMore.length; i += 1) {
      if (left() <= 0 || googleUnavailable || Date.now() >= deadlineMs) break;
      const orgId = wantMore[i]!;
      try {
        if (await refresh(orgId, Math.ceil(left() / (wantMore.length - i)), deadlineMs)) {
          next.push(orgId);
        }
      } catch (e) {
        void reportError(e, { tag: 'cron.price-pull', extra: { orgId } });
      }
    }
    wantMore = next;
  }
  const results = [...byOrg.values()];

  // One line per run, counts only (no org ids).
  console.info(
    '[cron.price-pull]',
    JSON.stringify({
      orgs: orgIds.length,
      reached: results.length,
      lookups: used,
      lookupCap: LOOKUP_CAP,
      written,
      rounds,
      googleUnavailable,
      failed: sweep.failed,
      heldByAnotherRun: sweep.heldByAnotherRun,
      orderedBy: sweep.orderedBy,
      promoted: sweep.promoted,
      leftForNextRun: sweep.leftForNextRun,
      ms: Date.now() - startedAt,
    }),
  );
  return NextResponse.json({
    ok: true,
    orgs: orgIds.length,
    results,
    leftForNextRun: sweep.leftForNextRun,
  });
}
