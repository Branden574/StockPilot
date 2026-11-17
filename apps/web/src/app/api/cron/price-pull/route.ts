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
/** How many of an organization's books one refresh reads (its window); what
 *  it may write is its share (maxWritten). */
const READ_WINDOW = 300;

/**
 * Daily Google Books price pull for every org with the price_tracking module enabled.
 *
 * FAIR SHARE of the run's budget (GLOBAL_CAP observations). The organizations
 * go least recently reached first (cron_sweep_attempts, job 'price_pull'),
 * and each is offered an equal part of what is left:
 * ceil(left / organizations not yet offered). An organization with a big
 * backlog therefore takes at most its share in that round, never the whole
 * budget; what a small one does not use passes on to the organizations after
 * it, and then round again to the ones that used all of their share
 * (round-robin), so the budget is not left unused while one has a backlog.
 * An organization the budget or the deadline did not reach is not stamped,
 * so it goes first tomorrow. Each organization is claimed as it starts, so a
 * second delivery of the tick spends nothing on it (Google's daily quota is
 * shared with scanning).
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

  // Global budget so one cron invocation can't exceed Vercel's maxDuration=60
  // (an uncatchable hard-kill would silently skip the remaining orgs) or blow
  // Google's daily quota. `deadlineMs` gives ~10s headroom; `GLOBAL_CAP` bounds
  // total observations across ALL orgs this run.
  //
  // Capped at 200 (was 500) to leave headroom in the Google Books daily quota
  // (~1,000 queries/day/project) for INTERACTIVE scans/imports — price pulls
  // and metadata lookups share the same key, and a 500-call pull at 9am used
  // to starve scanning for the rest of the day. Metadata lookups are now
  // cached (book_metadata_cache, 0262) so they rarely hit Google Books, but
  // price observations must stay fresh and can't be cached — so the cron gets
  // the smaller, bounded share.
  const GLOBAL_CAP = 200; // total observations per cron invocation
  const startedAt = Date.now();
  const deadlineMs = startedAt + 50_000; // headroom under maxDuration=60
  let used = 0;
  const left = () => GLOBAL_CAP - used;
  /** Per organization, summed over the rounds (the response's results). */
  const byOrg = new Map<
    string,
    { orgId: string; scanned: number; written: number; skipped: number }
  >();
  /** Per organization, the books looked up this run (not asked for again). */
  const triedByOrg = new Map<string, Set<string>>();
  /** One refresh of one organization with this share; true when it wrote the
   *  whole share (it may have more to price). Throws on a failed refresh. */
  const refresh = async (orgId: string, share: number): Promise<boolean> => {
    const tried = triedByOrg.get(orgId) ?? new Set<string>();
    triedByOrg.set(orgId, tried);
    const r = await refreshBookPricesForOrg(admin, orgId, googleBooksClient, {
      limit: READ_WINDOW,
      maxWritten: share,
      deadlineMs,
      tried,
    });
    used += r.written;
    const sum = byOrg.get(orgId) ?? { orgId, scanned: 0, written: 0, skipped: 0 };
    sum.scanned += r.scanned;
    sum.written += r.written;
    sum.skipped += r.skipped;
    byOrg.set(orgId, sum);
    // last_priced_at stamps bump updated_at → page-1 order changes.
    if (r.written > 0) revalidateInventoryList(orgId);
    return r.written >= share;
  };

  // Round one: every organization, least recently reached first, each claimed
  // as it starts and offered an equal part of what is left.
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
      stopWhen: () => left() <= 0,
    },
    async (orgId, index): Promise<{ result: 'success' | 'failure'; value: null }> => {
      try {
        if (await refresh(orgId, Math.ceil(left() / (orgIds.length - index)))) {
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
  // ones that used all of their share (this run's claims are already theirs),
  // in the same order, equal parts again, until the budget, the deadline or
  // the backlog runs out.
  let rounds = 1;
  while (wantMore.length > 0 && left() > 0 && Date.now() < deadlineMs) {
    rounds += 1;
    const next: string[] = [];
    for (let i = 0; i < wantMore.length; i += 1) {
      if (left() <= 0 || Date.now() >= deadlineMs) break;
      const orgId = wantMore[i]!;
      try {
        if (await refresh(orgId, Math.ceil(left() / (wantMore.length - i)))) next.push(orgId);
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
      written: used,
      cap: GLOBAL_CAP,
      rounds,
      failed: sweep.failed,
      heldByAnotherRun: sweep.heldByAnotherRun,
      orderedBy: sweep.orderedBy,
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
