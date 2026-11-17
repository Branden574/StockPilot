import 'server-only';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { fetchAllRows } from './paginate';

/**
 * Helpers for scheduled jobs that visit every organization: an order that
 * puts the organizations a job reached longest ago first, a record of each
 * job's attempts per organization (cron_sweep_attempts, 0492) that keeps
 * that order honest across runs, and a sweep that stops STARTING work at a
 * soft deadline and says how much it left.
 *
 * Why. A job that walks the organizations in the same order every run, and
 * stops at its time limit, reaches the same first ones every run and never
 * the rest. Ordering by "longest since this job last reached it" makes a
 * cut fall on different organizations each run,
 * so every one is reached within a bounded number of runs. The deadline only
 * stops new work from starting; work already started finishes inside the
 * route's maxDuration, so nothing is cut half way.
 */

/**
 * `ids` sorted so that the one with the oldest `lastAt` comes first. An id
 * with no entry (never reached, or the read that would say failed) comes
 * before every id that has one. Ties, including all the ids with no entry,
 * keep their order in `ids` (the sort is stable).
 */
export function oldestFirst(ids: readonly string[], lastAt: ReadonlyMap<string, number>): string[] {
  const keyOf = (id: string): number => {
    const v = lastAt.get(id);
    return v === undefined || !Number.isFinite(v) ? Number.NEGATIVE_INFINITY : v;
  };
  return [...ids].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

/**
 * The newest time per key in `rows` (for example the last restore point per
 * organization), as epoch milliseconds. Rows whose time does not parse are
 * left out.
 */
export function newestPerKey<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  timeOf: (row: Row) => string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const t = Date.parse(timeOf(row) ?? '');
    if (!Number.isFinite(t)) continue;
    const key = keyOf(row);
    const prev = out.get(key);
    if (prev === undefined || t > prev) out.set(key, t);
  }
  return out;
}

/** What happened to one item of a deadline sweep. */
export type SweepEntry<T, R> =
  | { item: T; started: false }
  | { item: T; started: true; ok: true; value: R }
  | { item: T; started: true; ok: false; error: unknown };

/**
 * Runs `fn` over `items` in order, at most `concurrency` at once, and starts
 * no item once `Date.now()` has reached `deadlineAt`. The check is made
 * right before each start, with nothing awaited between it and the call to
 * `fn`. An item that throws is recorded and never stops the others. Items
 * not started are returned as `started: false`, in order, so the caller can
 * report how many it left for the next run.
 */
export async function sweepUntilDeadline<T, R>(
  items: readonly T[],
  opts: { concurrency: number; deadlineAt: number },
  fn: (item: T) => Promise<R>,
): Promise<{ entries: SweepEntry<T, R>[]; started: number; leftForNextRun: number }> {
  const entries = await mapWithConcurrency(
    items,
    opts.concurrency,
    async (item): Promise<SweepEntry<T, R>> => {
      if (Date.now() >= opts.deadlineAt) return { item, started: false };
      try {
        return { item, started: true, ok: true, value: await fn(item) };
      } catch (error) {
        return { item, started: true, ok: false, error };
      }
    },
  );
  const started = entries.filter((e) => e.started).length;
  return { entries, started, leftForNextRun: entries.length - started };
}

/**
 * The jobs that record their attempts in cron_sweep_attempts (0492). The
 * table's CHECK takes any short lower-case name; this union keeps the code to
 * the names in use.
 */
export type CronSweepJob = 'exception_sync' | 'restore_points' | 'prewarm';

/** One job's attempt records, per organization. */
export interface CronAttempts {
  /** When the job last started the organization (epoch ms). */
  lastAttempt: Map<string, number>;
  /** Attempts in a row that ended without success. */
  failures: Map<string, number>;
}

/**
 * Reads one job's attempt records (cron_sweep_attempts, 0492), a page at a
 * time. Throws on a failed read: the caller orders without them and reports.
 */
export async function readCronAttempts(
  admin: ReturnType<typeof createAdminClient>,
  job: CronSweepJob,
): Promise<CronAttempts> {
  const rows = await fetchAllRows<{
    organization_id: string;
    last_attempt_at: string;
    consecutive_failures: number | null;
  }>((from, to) =>
    admin
      .from('cron_sweep_attempts')
      .select('organization_id, last_attempt_at, consecutive_failures')
      .eq('job', job)
      .order('organization_id', { ascending: true })
      .range(from, to),
  );
  const out: CronAttempts = { lastAttempt: new Map(), failures: new Map() };
  for (const r of rows) {
    out.lastAttempt.set(r.organization_id, Date.parse(r.last_attempt_at));
    out.failures.set(r.organization_id, Number(r.consecutive_failures ?? 0));
  }
  return out;
}

/** How one attempt ended: success resets the count, failure adds one, and
 *  neither (for example another run holds the organization) leaves it. */
export type CronAttemptResult = 'success' | 'failure' | 'neither';

/**
 * Records one run's attempts for a job. `start(orgId)` SENDS the attempt
 * stamp at once (before the caller's own first request for the organization)
 * and returns `finish(result)`, which awaits the stamp and answers the
 * attempts-in-a-row count.
 *
 * The stamp counts the attempt as a failure in advance (consecutive_failures
 * one more than before), and `finish` corrects it: success writes 0, neither
 * writes the old count back, failure leaves it. So an attempt that never
 * finishes, because the function was killed at maxDuration, is still counted
 * as a failure, and the organization still goes to the back of the line.
 *
 * With `countFailures: false` (a job with nothing to count, such as the
 * prewarm) the stamp writes only the time and `finish` only awaits it.
 *
 * A failed write never throws (the record is for ordering and counting only)
 * and is reported once per run under `reportTag`.
 */
export function cronAttemptRecorder(
  admin: ReturnType<typeof createAdminClient>,
  job: CronSweepJob,
  opts: {
    failuresBefore: ReadonlyMap<string, number>;
    reportTag: string;
    countFailures?: boolean;
  },
): { start(orgId: string): (result: CronAttemptResult) => Promise<number> } {
  let reported = false;
  const countFailures = opts.countFailures !== false;
  const write = async (
    orgId: string,
    row: { last_attempt_at: string; consecutive_failures?: number },
  ): Promise<void> => {
    const { error } = await admin
      .from('cron_sweep_attempts')
      .upsert({ job, organization_id: orgId, ...row }, { onConflict: 'job,organization_id' });
    if (error && !reported) {
      reported = true;
      void reportError(new Error(error.message), {
        tag: opts.reportTag,
        level: 'warning',
        extra: { step: 'write', job },
      });
    }
  };
  return {
    start(orgId) {
      const attemptedAt = new Date().toISOString();
      const before = opts.failuresBefore.get(orgId) ?? 0;
      const stamp = write(
        orgId,
        countFailures
          ? { last_attempt_at: attemptedAt, consecutive_failures: before + 1 }
          : { last_attempt_at: attemptedAt },
      );
      return async (result) => {
        await stamp;
        if (!countFailures) return before;
        if (result === 'failure') return before + 1;
        const settled = result === 'success' ? 0 : before;
        await write(orgId, { last_attempt_at: attemptedAt, consecutive_failures: settled });
        return settled;
      };
    },
  };
}
