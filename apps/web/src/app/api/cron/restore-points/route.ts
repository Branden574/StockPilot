import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  cronAttemptRecorder,
  newestPerKey,
  oldestFirst,
  readCronAttempts,
  sweepUntilDeadline,
  type CronAttempts,
} from '@/server/services/lib/cron-sweep';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { systemContextLoader } from '@/server/services/lib/system-context';
import { createSnapshot } from '@/server/services/restore-points';

import { planAllowsRestorePoints, type OrgBillingState } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * The hard limit. 300, like daily-briefing and exception-occurrences, and
 * far above the soft deadline below: the deadline only stops organizations
 * from STARTING, and a snapshot already started (up to 50,000 items read a
 * page at a time, then one INSERT) gets the gap to finish.
 */
export const maxDuration = 300;

/** Stop STARTING snapshots after this long (see maxDuration). */
const RUN_DEADLINE_MS = 200_000;
/** One snapshot at a time, as before. A snapshot holds up to 50,000 items in
 *  memory (the rows, the mapped items and the JSON at once), so the item cap
 *  bounds the peak only while one runs at a time. The fairness comes from the
 *  order, not from running in parallel. */
const CONCURRENCY = 1;
/** An organization whose attempts have ended without a point this many
 *  times in a row is counted in the run's log line (failingRepeatedly). */
const REPEATED_FAILURES = 3;
/** How far back the ordering read looks for each organization's last
 *  automatic point. An organization with none in this window goes first. */
const LAST_POINT_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Daily automatic restore-point cron. Snapshots every Business+ org's inventory
 * (createSnapshot also prunes to the retention window). CRON_SECRET-gated;
 * FAIL-OPEN per org. Mirrors the auto-reorder cron's per-org system context.
 *
 * Order: least recently reached first: the later of the organization's last
 * automatic restore point and this cron's last attempt at it
 * (cron_sweep_attempts, job 'restore_points', 0469; recorded as the
 * organization starts). Neither in the last three days: first of all, in id
 * order. Counting the attempt sends an organization whose snapshot fails (or
 * that has no owner or admin) to the back of the line too, so it cannot be
 * tried first, and use up the run, every night. A run that
 * reaches its deadline stops starting snapshots, says how many organizations
 * it left (one log line, and a warning to the error reporter), and those go
 * first on the next run. A snapshot is written whole or not at all:
 * createSnapshot reads every item before its single INSERT, so a stop before
 * the INSERT writes nothing.
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!secretsEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const admin = createAdminClient();

  try {
    // All orgs (paginated) → keep the Business+ ones.
    const orgs = await fetchAllRows<
      OrgBillingState & { id: string }
    >((from, to) =>
      admin
        .from('organizations')
        .select(
          'id, plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
        )
        .order('id', { ascending: true })
        .range(from, to),
    );
    const eligible = orgs.filter((o) => planAllowsRestorePoints(o));

    // Ordering only: if this read fails, the run goes in id order.
    let lastPoint = new Map<string, number>();
    try {
      const since = new Date(startedAt - LAST_POINT_LOOKBACK_MS).toISOString();
      const rows = await fetchAllRows<{ id: string; organization_id: string; created_at: string }>(
        (from, to) =>
          admin
            .from('restore_points')
            .select('id, organization_id, created_at')
            .eq('kind', 'auto')
            .gte('created_at', since)
            .order('id', { ascending: true })
            .range(from, to),
      );
      lastPoint = newestPerKey(rows, (r) => r.organization_id, (r) => r.created_at);
    } catch (err) {
      void reportError(err, { tag: 'cron.restore-points.order', level: 'warning' });
    }
    let attempts: CronAttempts = { lastAttempt: new Map(), failures: new Map() };
    try {
      attempts = await readCronAttempts(admin, 'restore_points');
    } catch (err) {
      void reportError(err, { tag: 'cron.restore-points.attempts', level: 'warning' });
    }
    const reachedAt = new Map(lastPoint);
    for (const [orgId, at] of attempts.lastAttempt) {
      if (!Number.isFinite(at)) continue;
      reachedAt.set(orgId, Math.max(at, reachedAt.get(orgId) ?? Number.NEGATIVE_INFINITY));
    }
    const ordered = oldestFirst(
      eligible.map((o) => o.id),
      reachedAt,
    );

    // A failed attempt write never stops a snapshot; reported once per run.
    const recorder = cronAttemptRecorder(admin, 'restore_points', {
      failuresBefore: attempts.failures,
      reportTag: 'cron.restore-points.attempts',
    });
    const loadContext = systemContextLoader(admin, 'cron.restore-points.context');
    let failingRepeatedly = 0;
    const sweep = await sweepUntilDeadline(
      ordered,
      { concurrency: CONCURRENCY, deadlineAt: startedAt + RUN_DEADLINE_MS },
      async (orgId): Promise<'snapshotted' | 'no_owner' | 'failed'> => {
        // Recorded as the org starts: sent before its first read, awaited
        // after the snapshot.
        const finish = recorder.start(orgId);
        let result: 'snapshotted' | 'no_owner' | 'failed';
        try {
          const loaded = await loadContext(orgId);
          if (loaded.ok) {
            await createSnapshot(loaded.ctx, { kind: 'auto', label: null });
            result = 'snapshotted';
          } else if (loaded.reason === 'no_actor') {
            result = 'no_owner';
          } else {
            // The owner/admin or the module set could not be read: failed
            // (reported once per run), never "no owner".
            result = 'failed';
          }
        } catch (e) {
          void reportError(e, { tag: 'cron.restore-points.org', extra: { orgId } });
          result = 'failed';
        }
        const inARow = await finish(result === 'snapshotted' ? 'success' : 'failure');
        if (inARow >= REPEATED_FAILURES) failingRepeatedly += 1;
        return result;
      },
    );
    const count = (status: string) =>
      sweep.entries.filter((e) => e.started && e.ok && e.value === status).length;
    const snapshotted = count('snapshotted');
    const noOwner = count('no_owner');
    const failed = count('failed');
    const leftForNextRun = sweep.leftForNextRun;

    if (leftForNextRun > 0) {
      void reportError(new Error('Restore points stopped at the run deadline'), {
        tag: 'cron.restore-points.deadline',
        level: 'warning',
        extra: { eligible: eligible.length, snapshotted, leftForNextRun },
      });
    }
    // One line per run, counts only (no org ids).
    console.info(
      '[cron.restore-points]',
      JSON.stringify({
        eligible: eligible.length,
        snapshotted,
        noOwner,
        failed,
        failingRepeatedly,
        leftForNextRun,
        ms: Date.now() - startedAt,
      }),
    );

    return NextResponse.json({
      eligible: eligible.length,
      snapshotted,
      noOwner,
      failed,
      leftForNextRun,
    });
  } catch (err) {
    return internalErrorResponse(err, 'cron.restore-points');
  }
}
