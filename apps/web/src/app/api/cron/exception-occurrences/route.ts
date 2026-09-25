import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ExceptionOccurrencesService,
  type ExceptionSyncOutcome,
} from '@/server/services/exception-occurrences';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { secretsEqual } from '@/server/services/lib/system-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit (Vercel kills the invocation, uncatchably, at this many
 * seconds). 300, like daily-briefing, and far above the soft deadline below,
 * because the deadline only stops orgs from STARTING: the org in flight when
 * it passes still has to finish. One org is several round trips one after
 * another (throttle read, context, the evaluator's reads, the RPC, which may
 * also wait up to 5 s for the org's lock), and Vercel-to-Supabase calls stall
 * for 1 to 8 s at times. With maxDuration 60, an org started at 44 s in such
 * a period was killed at 60 s, losing the tally, the deadline report and any
 * knowledge of whether its RPC committed.
 */
export const maxDuration = 300;

/**
 * Stop STARTING new orgs after this long, so a slow run stops itself, says
 * how many orgs it left for the next run, and those go first next time (see
 * the sweep order). The gap to maxDuration is the room the org in flight
 * gets to finish.
 */
const SWEEP_DEADLINE_MS = 45_000;

/** Last synced longer ago than this: due for this run. */
const OVERDUE_MS = 10 * 60_000;
/** Last synced longer ago than this, with a sync every 15 minutes: it has
 *  been failing, so it goes after the orgs that are healthy. */
const FAILING_MS = 60 * 60_000;

/**
 * The sweep order. By tier, then least recently synced first:
 *   0. due: synced 10 to 60 minutes ago (the normal case);
 *   1. never synced (a new org's first check), in id order;
 *   2. not synced for over an hour (failing run after run: an RPC error, a
 *      lock that is always busy), so they cannot use up the time budget
 *      ahead of healthy orgs;
 *   3. synced in the last 10 minutes (a posted count's follow-up), which
 *      are cheap or throttled.
 * Ordering "never synced" first, as before, let a set of orgs that never
 * complete a sync (for example one with no owner or admin) lead every run.
 * The sort is stable, so ties keep id order. Without the sync-state read
 * every org is tier 1, which is plain id order.
 */
function sweepOrder(
  orgIds: readonly string[],
  lastSynced: ReadonlyMap<string, number>,
  now: number,
): string[] {
  const rank = (id: string): [number, number] => {
    const last = lastSynced.get(id);
    if (last === undefined || !Number.isFinite(last)) return [1, 0];
    const age = now - last;
    if (age < OVERDUE_MS) return [3, last];
    if (age < FAILING_MS) return [0, last];
    return [2, last];
  };
  return [...orgIds].sort((a, b) => {
    const [ta, la] = rank(a);
    const [tb, lb] = rank(b);
    return ta !== tb ? ta - tb : la - lb;
  });
}

/**
 * EXCEPTION CENTER SYNC (F1-1), every 15 minutes (vercel.json).
 *
 * For each org, the system evaluates the Exception Center rules org-wide and
 * applies the result to the stored occurrences (exceptions_sync): new
 * conditions are raised with EX numbers, conditions that are gone are
 * resolved, and exception_sync_state records when ("Checked at").
 *
 * This is the main way occurrences stay fresh. Owner decision (F1 Q9):
 * freshness must not slow a page or the system down, so NO page view and no
 * API read syncs; besides this cron, only a posted or cancelled count and a
 * manager's "Check now" schedule a sync, and those run after their response.
 *
 * CRON_SECRET-gated (the shared constant-time secretsEqual). FAIL-OPEN per
 * org: syncOrg never throws, reports its own failures
 * (exceptions.sync_failed), and one org's failure never stops the rest.
 * Orgs run one at a time, in sweepOrder (due orgs first, least recently
 * synced first), so the sweep never herds the database and a deadline cut
 * rotates fairly.
 */
export async function GET(req: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'cron_disabled' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const tally: Record<ExceptionSyncOutcome['status'], number> = {
    applied: 0,
    stale: 0,
    throttled: 0,
    no_system_actor: 0,
    busy: 0,
    failed: 0,
  };

  try {
    const admin = createAdminClient();
    const orgs = await fetchAllRows<{ id: string }>((from, to) =>
      admin.from('organizations').select('id').order('id', { ascending: true }).range(from, to),
    );

    // Ordering only (sweepOrder); if this read fails the sweep still runs, in
    // id order.
    const lastSynced = new Map<string, number>();
    try {
      const states = await fetchAllRows<{ organization_id: string; last_synced_at: string }>(
        (from, to) =>
          admin
            .from('exception_sync_state')
            .select('organization_id, last_synced_at')
            .order('organization_id', { ascending: true })
            .range(from, to),
      );
      for (const s of states) lastSynced.set(s.organization_id, Date.parse(s.last_synced_at));
    } catch (err) {
      void reportError(err, { tag: 'cron.exception-occurrences.order', level: 'warning' });
    }
    const ordered = sweepOrder(
      orgs.map((o) => o.id),
      lastSynced,
      startedAt,
    ).map((id) => ({ id }));

    let processed = 0;
    for (const org of ordered) {
      if (Date.now() - startedAt >= SWEEP_DEADLINE_MS) break;
      // Unforced: an org synced within the last minute (a count was just
      // posted there) is skipped by syncOrg's own throttle. syncOrg never
      // throws; the catch is there so one org can never end the sweep even
      // if that promise is ever broken.
      let outcome: ExceptionSyncOutcome;
      try {
        outcome = await ExceptionOccurrencesService.syncOrg(org.id, { reason: 'cron' });
      } catch (err) {
        void reportError(err, {
          tag: 'exceptions.sync_failed',
          organizationId: org.id,
          extra: { reason: 'cron' },
        });
        outcome = { status: 'failed' };
      }
      tally[outcome.status] += 1;
      processed += 1;
    }
    const deferred = ordered.length - processed;
    if (deferred > 0) {
      void reportError(new Error('Exception sync sweep stopped at its deadline'), {
        tag: 'cron.exception-occurrences.deadline',
        level: 'warning',
        extra: { processed, deferred },
      });
    }

    return NextResponse.json({
      orgs: ordered.length,
      processed,
      deferredForTime: deferred,
      ...tally,
    });
  } catch (err) {
    void reportError(err, { tag: 'cron.exception-occurrences' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
