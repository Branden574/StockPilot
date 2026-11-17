import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ExceptionOccurrencesService,
  type ExceptionSyncOutcome,
} from '@/server/services/exception-occurrences';
import { sweepUntilDeadline } from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { secretsEqual } from '@/server/services/lib/system-context';

import { exceptionSweepOrder } from './sweep-order';

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

/**
 * Organizations synced at once. Each sync reads and writes only its own
 * organization (exceptions_sync takes that organization's lock), so a few at
 * once never touch each other; three keeps the database calm. The deadline is
 * checked before each start.
 */
const CONCURRENCY = 3;

/** An organization whose attempts have ended without a sync this many times
 *  in a row is counted in the run's log line (failingRepeatedly). */
const REPEATED_FAILURES = 3;

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
 * Orgs run three at a time, least recently REACHED first (exceptionSweepOrder:
 * the later of the last applied sync and the cron's last attempt). The cron
 * records each attempt (exception_sync_attempts, 0492) as it starts the org,
 * so an org it reached goes to the back of the line whether or not the sync
 * applied, and a deadline cut rotates through every org.
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
    const orgs = await fetchAllRows<{ id: string; created_at?: string | null }>((from, to) =>
      admin
        .from('organizations')
        .select('id, created_at')
        .order('id', { ascending: true })
        .range(from, to),
    );

    // Ordering only (exceptionSweepOrder); if a read fails the sweep still
    // runs, ordered by what the other read gave (both failed: id order).
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
    const lastAttempt = new Map<string, number>();
    const failuresBefore = new Map<string, number>();
    try {
      const attempts = await fetchAllRows<{
        organization_id: string;
        last_attempt_at: string;
        consecutive_failures: number | null;
      }>((from, to) =>
        admin
          .from('exception_sync_attempts')
          .select('organization_id, last_attempt_at, consecutive_failures')
          .order('organization_id', { ascending: true })
          .range(from, to),
      );
      for (const a of attempts) {
        lastAttempt.set(a.organization_id, Date.parse(a.last_attempt_at));
        failuresBefore.set(a.organization_id, Number(a.consecutive_failures ?? 0));
      }
    } catch (err) {
      void reportError(err, { tag: 'cron.exception-occurrences.attempts', level: 'warning' });
    }
    const ordered = exceptionSweepOrder(
      orgs.map((o) => ({ id: o.id, createdAt: o.created_at ?? null })),
      lastSynced,
      lastAttempt,
      startedAt,
    );

    // The attempt record. A failed write never stops a sync (the record is
    // for ordering and the log line only) and is reported once per run.
    let attemptWriteReported = false;
    const recordAttempt = async (
      orgId: string,
      row: { last_attempt_at: string; consecutive_failures?: number },
    ): Promise<void> => {
      const { error } = await admin
        .from('exception_sync_attempts')
        .upsert({ organization_id: orgId, ...row }, { onConflict: 'organization_id' });
      if (error && !attemptWriteReported) {
        attemptWriteReported = true;
        void reportError(new Error(error.message), {
          tag: 'cron.exception-occurrences.attempts',
          level: 'warning',
          extra: { step: 'write' },
        });
      }
    };

    let failingRepeatedly = 0;
    const sweep = await sweepUntilDeadline(
      ordered,
      { concurrency: CONCURRENCY, deadlineAt: startedAt + SWEEP_DEADLINE_MS },
      async (orgId): Promise<ExceptionSyncOutcome> => {
        // Recorded as the org starts: the write is sent before the sync's
        // first read, and awaited after it.
        const attemptedAt = new Date().toISOString();
        const attempt = recordAttempt(orgId, { last_attempt_at: attemptedAt });
        // Unforced: an org synced within the last minute (a count was just
        // posted there) is skipped by syncOrg's own throttle. syncOrg never
        // throws; the catch is there so one org can never end the sweep even
        // if that promise is ever broken.
        let outcome: ExceptionSyncOutcome;
        try {
          outcome = await ExceptionOccurrencesService.syncOrg(orgId, { reason: 'cron' });
        } catch (err) {
          void reportError(err, {
            tag: 'exceptions.sync_failed',
            organizationId: orgId,
            extra: { reason: 'cron' },
          });
          outcome = { status: 'failed' };
        }
        await attempt;
        // Attempts in a row that ended without a sync. busy (another sync
        // held the lock) is neither: that org is being synced.
        const before = failuresBefore.get(orgId) ?? 0;
        if (outcome.status === 'failed' || outcome.status === 'no_system_actor') {
          if (before + 1 >= REPEATED_FAILURES) failingRepeatedly += 1;
          await recordAttempt(orgId, {
            last_attempt_at: attemptedAt,
            consecutive_failures: before + 1,
          });
        } else if (outcome.status !== 'busy' && before > 0) {
          await recordAttempt(orgId, { last_attempt_at: attemptedAt, consecutive_failures: 0 });
        }
        return outcome;
      },
    );

    // Summed over the orgs applied, for the run's log line (L102) and the
    // body. settled: count_variance entries held because their count line was
    // confirmed (0386).
    let raised = 0;
    let resolved = 0;
    let recountsClosed = 0;
    let settled = 0;
    for (const entry of sweep.entries) {
      if (!entry.started) continue;
      const outcome: ExceptionSyncOutcome = entry.ok ? entry.value : { status: 'failed' };
      tally[outcome.status] += 1;
      if (outcome.status === 'applied') {
        raised += outcome.raised;
        resolved += outcome.resolved;
        recountsClosed += outcome.recountsClosed;
        settled += outcome.settled;
      }
    }
    const processed = sweep.started;
    const deferred = sweep.leftForNextRun;
    if (deferred > 0) {
      void reportError(new Error('Exception sync sweep stopped at its deadline'), {
        tag: 'cron.exception-occurrences.deadline',
        level: 'warning',
        extra: { processed, deferred },
      });
    }

    // One line per run, counts only (no org ids): a successful run used to
    // log nothing, so its work was visible only in the response (L102).
    console.info(
      '[cron.exception-occurrences]',
      JSON.stringify({
        orgs: ordered.length,
        processed,
        deferredForTime: deferred,
        ...tally,
        failingRepeatedly,
        raised,
        resolved,
        recountsClosed,
        settled,
        ms: Date.now() - startedAt,
      }),
    );

    return NextResponse.json({
      orgs: ordered.length,
      processed,
      deferredForTime: deferred,
      ...tally,
      raised,
      resolved,
      settled,
    });
  } catch (err) {
    void reportError(err, { tag: 'cron.exception-occurrences' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
