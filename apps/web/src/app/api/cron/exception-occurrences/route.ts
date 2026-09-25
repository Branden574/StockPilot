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
export const maxDuration = 60;

/**
 * Stop STARTING new orgs after this long. Vercel's maxDuration kill is
 * uncatchable, so without a soft deadline a slow run would lose the rest of
 * the sweep AND the response body; this way the run stops itself, says how
 * many orgs it left for the next run, and those go first next time (the
 * sweep order is least recently synced first).
 */
const SWEEP_DEADLINE_MS = 45_000;

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
 * Orgs run one at a time, least recently synced first, so the sweep never
 * herds the database and a deadline cut rotates fairly.
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

    // Least recently synced first (never-synced orgs lead). Ordering only; if
    // this read fails the sweep still runs, in id order.
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
    // Never synced reads as 0 (the epoch), so it sorts first; the sort is
    // stable, so ties keep id order.
    const ordered = [...orgs].sort(
      (a, b) => (lastSynced.get(a.id) ?? 0) - (lastSynced.get(b.id) ?? 0),
    );

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
