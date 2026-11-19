import 'server-only';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';

import { fetchAllRows } from './paginate';

/**
 * Helpers for scheduled jobs that visit every organization: an order that
 * puts the organizations a job reached longest ago first, a record of each
 * job's attempts per organization (cron_sweep_attempts, 0469) that keeps
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
  opts: {
    concurrency: number;
    deadlineAt: number;
    /** Checked with the deadline: true stops starting items too (a budget). */
    stopWhen?: () => boolean;
  },
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ entries: SweepEntry<T, R>[]; started: number; leftForNextRun: number }> {
  const entries = await mapWithConcurrency(
    items,
    opts.concurrency,
    async (item, index): Promise<SweepEntry<T, R>> => {
      if (Date.now() >= opts.deadlineAt || opts.stopWhen?.() === true) {
        return { item, started: false };
      }
      try {
        return { item, started: true, ok: true, value: await fn(item, index) };
      } catch (error) {
        return { item, started: true, ok: false, error };
      }
    },
  );
  const started = entries.filter((e) => e.started).length;
  return { entries, started, leftForNextRun: entries.length - started };
}

/** The fractional part of the golden ratio: the step of rotateByClock. */
const GOLDEN_STEP = (Math.sqrt(5) - 1) / 2;

/**
 * `ids` turned to start at a place that moves with the clock: the run's slot
 * (floor(now / slotMs)) times the golden ratio, keeping the fraction, times
 * the length. This is the order a job falls back to when it cannot read its
 * attempt records: id order would put the same organizations first on every
 * run, and a run cut by its deadline would cut the same ones every time.
 *
 * The starts of consecutive slots spread over the whole list (a Weyl
 * sequence: each new start falls in one of the largest gaps the earlier ones
 * left), so with C organizations reached per run every organization is
 * reached within about 2.7 * N / C runs. Nothing is stored or read.
 */
export function rotateByClock(ids: readonly string[], now: number, slotMs: number): string[] {
  const n = ids.length;
  if (n <= 1) return [...ids];
  const slot = Math.floor(now / Math.max(1, slotMs));
  const fraction = (((slot * GOLDEN_STEP) % 1) + 1) % 1;
  const start = Math.min(n - 1, Math.floor(fraction * n));
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/**
 * One run's order: the organizations this job reached longest ago first
 * (oldestFirst on `lastAttempt`), or, when the attempt records could not be
 * read (`lastAttempt` null), rotateByClock.
 */
export function sweepOrder(
  ids: readonly string[],
  lastAttempt: ReadonlyMap<string, number> | null,
  opts: { now: number; slotMs: number },
): string[] {
  return lastAttempt ? oldestFirst(ids, lastAttempt) : rotateByClock(ids, opts.now, opts.slotMs);
}

/**
 * The jobs that record their attempts in cron_sweep_attempts (0469). The
 * table's CHECK takes any short lower-case name; this union keeps the code to
 * the names in use.
 */
export type CronSweepJob =
  | 'exception_sync'
  | 'restore_points'
  | 'prewarm'
  | 'auto_reorder'
  | 'auto_delete_archived'
  | 'auto_archive_zero_stock'
  | 'recurring_pos'
  | 'daily_briefing'
  | 'weekly_digest'
  | 'price_pull';

/** One job's attempt records, per organization. */
export interface CronAttempts {
  /** When the job last started the organization (epoch ms). */
  lastAttempt: Map<string, number>;
  /** Attempts in a row that ended without success. */
  failures: Map<string, number>;
}

/**
 * Reads one job's attempt records (cron_sweep_attempts, 0469), a page at a
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
 *  neither (nothing to do: the job is off for the organization, or it has no
 *  owner or admin to act as) leaves it, see settledFailures. */
export type CronAttemptResult = 'success' | 'failure' | 'neither';

/**
 * The attempts-in-a-row count an attempt that FINISHED leaves (`before`: the
 * count when the run read it). Success: 0. Failure: one more. Neither: the
 * count as it was, except that a neither right after a FIRST failure clears
 * it (0).
 *
 * Why the exception: one failure (count 1) is what retryFirstOnce moves to
 * the front of the next run, meant for an attempt killed at maxDuration. If a
 * neither left that 1 as it was, an organization that failed once and then
 * had nothing to do (the job turned off, no owner) would stay at 1 and be
 * moved to the front on every run while it stayed that way. Its attempt
 * after the failure did finish, so the front place has done its job.
 * (Leaving the count unwritten is not an option: the stamp at the start has
 * already counted the attempt as a failure in advance, so no write would make
 * every neither a failure, and an organization with the job off would count
 * as failing repeatedly after three runs.)
 */
export function settledFailures(result: CronAttemptResult, before: number): number {
  if (result === 'success') return 0;
  if (result === 'failure') return before + 1;
  return before === 1 ? 0 : before;
}

/**
 * Records one run's attempts for a job. `start(orgId)` SENDS the attempt
 * stamp at once (before the caller's own first request for the organization)
 * and returns `finish(result)`, which awaits the stamp and answers the
 * attempts-in-a-row count.
 *
 * The stamp counts the attempt as a failure in advance (consecutive_failures
 * one more than before), and `finish` corrects it (settledFailures): success
 * writes 0, neither writes the old count back (0 after a first failure),
 * failure leaves it. So an attempt that never
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
      // Codes only: no database text (`||`: a fetch-level failure can carry
      // an empty code). The code is in the message for a chat webhook.
      const code = error.code || 'unknown';
      void reportError(new Error(`Scheduled job could not record its attempt (code ${code})`), {
        tag: opts.reportTag,
        level: 'warning',
        extra: { step: 'write', job, code },
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
        const settled = settledFailures(result, before);
        if (result === 'failure') return settled;
        await write(orgId, { last_attempt_at: attemptedAt, consecutive_failures: settled });
        return settled;
      };
    },
  };
}

/**
 * How long a once-a-day job's claim on an organization holds: a second
 * delivery of the same tick, or a manual run the same day, finds it held.
 * Shorter than a day so the next day's run is never refused (4 hours of
 * slack for a late delivery). The cost: a manual run does nothing for an
 * organization started in the last 20 hours, a failed one included (it waits
 * for the next day), and a manual run late in the day makes the next
 * scheduled run skip what it started.
 */
export const DAILY_CLAIM_HOLD_MS = 20 * 60 * 60_000;

/**
 * What a claiming job does with an organization whose claim cannot be
 * recorded (cronAttemptClaimer): 'run' it unclaimed (fail open, the default)
 * or 'skip' it for this run (fail closed).
 */
export type OnClaimUnavailable = 'skip' | 'run';

/** cronAttemptClaimer's answer, with onClaimUnavailable 'skip', for an
 *  organization whose claim could not be recorded: skip it this run. */
export const CLAIM_UNAVAILABLE = 'claim_unavailable' as const;

/** How long a claim that errored waits before its one retry. */
export const CLAIM_RETRY_MS = 250;
/** Failed retries in one run after which a claim that errors is no longer
 *  retried: the claims are likely down for everyone, and waiting on each
 *  would spend the run's time for nothing. */
export const CLAIM_RETRY_GIVE_UP_AFTER = 3;

/**
 * One run's retries of claims that errored (an error other than the key): a
 * claim is tried again once, after `delayMs`, so one passing error does not
 * cost an organization its day or a member their week. Once
 * CLAIM_RETRY_GIVE_UP_AFTER retries in the run have failed too, `wait`
 * answers false at once (no retry).
 */
export function claimRetries(delayMs: number = CLAIM_RETRY_MS): {
  /** Waits before a retry; false when the run has stopped retrying. */
  wait(): Promise<boolean>;
  /** Records a retry that failed too. */
  retryFailed(): void;
} {
  let failed = 0;
  return {
    async wait() {
      if (failed >= CLAIM_RETRY_GIVE_UP_AFTER) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return true;
    },
    retryFailed() {
      failed += 1;
    },
  };
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return error.code === '23505' || (error.message ?? '').includes('duplicate key value');
}

/**
 * Like cronAttemptRecorder, but the attempt stamp is also a CLAIM: one run per
 * organization per `holdMs`. `claim(orgId)` resolves to null when another run
 * started the organization less than `holdMs` ago (a cron tick delivered
 * twice, or a manual run over the scheduled one); the caller skips it. Else it
 * resolves to `finish(result)`, as cronAttemptRecorder's start does, after
 * the stamp is written.
 *
 * The claim is atomic in the database: an UPDATE of the job's row for the
 * organization only when its last_attempt_at is older than the hold, then,
 * when no row matched, an INSERT that the primary key (job, organization_id)
 * lets only one run make. Two runs racing for the same organization: one
 * update or insert wins, the other matches nothing and meets the key.
 *
 * Like the recorder, the stamp counts the attempt as a failure in advance and
 * `finish` corrects it, so an attempt killed at maxDuration is a failure and
 * the organization is at the back of the line (and held until the hold ends).
 *
 * When the claim cannot be recorded (an error other than the key: the table
 * missing because the web deploy went out before the migration, a refused
 * write), `onClaimUnavailable` decides:
 *   'run' (the default): FAILS OPEN. The caller runs the organization
 *     unclaimed, as before this table existed, and the job's own atomic guard
 *     still applies (the reorder lock, the template schedule's
 *     compare-and-set, the archive and purge updates' row guards). Reported
 *     once per run under `reportTag`.
 *   'skip': FAILS CLOSED, for a job with no atomic guard of its own, where
 *     two runs at once would do the same work twice. The claim is tried once
 *     more after CLAIM_RETRY_MS (claimRetries), so one passing error does not
 *     cost the organization its day. When the retry errors too, `claim`
 *     resolves to CLAIM_UNAVAILABLE and the caller skips the organization for
 *     this run. Reported once per run under `reportTag`, with the error's
 *     code only (in the message too: a chat webhook shows only the message).
 *     Usually nothing was written, so the organization keeps its place at the
 *     front of the next run's order. Not always: an UPDATE or INSERT that
 *     committed but whose reply was lost did write the stamp, so the hold
 *     applies (the next run within it skips the organization as held) and
 *     its count of failures in a row has gone up by one. The retry then
 *     meets that stamp (the UPDATE matches nothing and the INSERT meets the
 *     key) and answers null: held, which is right, as the stamp is there.
 * Never throws.
 */
export function cronAttemptClaimer(
  admin: ReturnType<typeof createAdminClient>,
  job: CronSweepJob,
  opts: {
    failuresBefore: ReadonlyMap<string, number>;
    reportTag: string;
    holdMs: number;
    onClaimUnavailable?: OnClaimUnavailable;
    /** The wait before a retry with 'skip' (default CLAIM_RETRY_MS). */
    retryDelayMs?: number;
  },
): {
  claim(
    orgId: string,
  ): Promise<((result: CronAttemptResult) => Promise<number>) | null | typeof CLAIM_UNAVAILABLE>;
  /** The code of the last claim error that skipped an organization, if any. */
  readonly unavailableCode: string | null;
} {
  const skipUnclaimed = opts.onClaimUnavailable === 'skip';
  let reported = false;
  const report = (error: { code?: string }, step: 'claim' | 'write') => {
    if (reported) return;
    reported = true;
    // Codes only, the shape of the skip report: no database text.
    const code = error.code || 'unknown';
    void reportError(
      new Error(
        step === 'claim'
          ? `Scheduled job ran organizations whose claim could not be recorded (code ${code})`
          : `Scheduled job could not record its attempt (code ${code})`,
      ),
      {
        tag: opts.reportTag,
        level: 'warning',
        extra: { step, job, code },
      },
    );
  };
  let reportedSkip = false;
  let unavailableCode: string | null = null;
  const skip = (error: { code?: string }): typeof CLAIM_UNAVAILABLE => {
    // `||`: a fetch-level failure can carry an empty code.
    const code = error.code || 'unknown';
    unavailableCode = code;
    if (!reportedSkip) {
      reportedSkip = true;
      void reportError(
        new Error(
          `Scheduled job skipped organizations whose claim could not be recorded (code ${code})`,
        ),
        {
          tag: opts.reportTag,
          level: 'warning',
          extra: { step: 'claim', job, code, onClaimUnavailable: 'skip' },
        },
      );
    }
    return CLAIM_UNAVAILABLE;
  };
  const retries = claimRetries(opts.retryDelayMs);
  return {
    get unavailableCode() {
      return unavailableCode;
    },
    async claim(orgId) {
      const at = Date.now();
      const attemptedAt = new Date(at).toISOString();
      const before = opts.failuresBefore.get(orgId) ?? 0;
      const stamp = { last_attempt_at: attemptedAt, consecutive_failures: before + 1 };
      const unrecorded = async (): Promise<number> => before;
      const finish = async (result: CronAttemptResult): Promise<number> => {
        const settled = settledFailures(result, before);
        if (result === 'failure') return settled;
        const { error } = await admin.from('cron_sweep_attempts').upsert(
          {
            job,
            organization_id: orgId,
            last_attempt_at: attemptedAt,
            consecutive_failures: settled,
          },
          { onConflict: 'job,organization_id' },
        );
        if (error) report(error, 'write');
        return settled;
      };

      // The error of the last attempt that failed (kept here, never answered).
      const last: { failure: { message: string; code?: string } | null } = { failure: null };
      const FAILED = Symbol('claim failed');
      const attempt = async (): Promise<typeof finish | null | typeof FAILED> => {
        last.failure = null;
        const taken = await admin
          .from('cron_sweep_attempts')
          .update(stamp)
          .eq('job', job)
          .eq('organization_id', orgId)
          .lt('last_attempt_at', new Date(at - opts.holdMs).toISOString())
          .select('organization_id');
        if (taken.error) {
          last.failure = taken.error;
          return FAILED;
        }
        if (Array.isArray(taken.data) && taken.data.length > 0) return finish;

        const inserted = await admin
          .from('cron_sweep_attempts')
          .insert({ job, organization_id: orgId, ...stamp });
        if (!inserted.error) return finish;
        if (isUniqueViolation(inserted.error)) return null;
        last.failure = inserted.error;
        return FAILED;
      };

      let outcome = await attempt();
      if (skipUnclaimed && outcome === FAILED && (await retries.wait())) {
        outcome = await attempt();
        if (outcome === FAILED) retries.retryFailed();
      }
      if (outcome !== FAILED) return outcome;
      const error = last.failure ?? { message: 'claim failed' };
      if (skipUnclaimed) return skip(error);
      report(error, 'claim');
      return unrecorded;
    },
  };
}

/** The most organizations retryFirstOnce moves to the front of one run. */
export const RETRY_FIRST_LIMIT = 3;

/**
 * `ordered` with the organizations whose last attempt is their FIRST in a row
 * without success (consecutive_failures 1) moved to the front, in their
 * order, at most `limit` of them (the rest keep their place). Why: a run that
 * starts every organization stamps them in its own order, so the next run's
 * oldest-first order is the same, and an organization that does not fit in
 * the time the others leave at the end would be killed at maxDuration every
 * run, forever. A killed attempt keeps its provisional count (one more than
 * before), so it is first next run, with the whole run's time. From the
 * second failure in a row it goes back to the plain order, so one that never
 * fits cannot take the front every day, and an attempt that finishes with
 * nothing to do clears a first failure (settledFailures). The limit keeps a
 * bad day (many organizations failing once) from turning the next run's
 * order upside down. `promoted`: how many were moved (for the log line).
 */
export function retryFirstOnce(
  ordered: readonly string[],
  failures: ReadonlyMap<string, number>,
  limit: number = RETRY_FIRST_LIMIT,
): { order: string[]; promoted: number } {
  const first = ordered.filter((id) => failures.get(id) === 1).slice(0, Math.max(0, limit));
  if (first.length === 0) return { order: [...ordered], promoted: 0 };
  const moved = new Set(first);
  return { order: [...first, ...ordered.filter((id) => !moved.has(id))], promoted: first.length };
}

/** One organization's work in sweepOrganizations: what to count, and how the
 *  attempt ended for the attempts-in-a-row count. */
export interface OrgWorkOutcome<V> {
  result: CronAttemptResult;
  value: V;
}

/** What sweepOrganizations did, for the route's one log line and its body. */
export interface OrgSweepOutcome<V> {
  /** The organizations worked, in the order they started, with their values. */
  done: Array<{ orgId: string; value: V }>;
  /** Organizations whose attempt ended as a failure, a throw included. */
  failed: number;
  /** Of those, the ones whose work threw (reported under `<tag>.org`). */
  threw: number;
  /** Organizations another run held (claimed within the hold); skipped. */
  heldByAnotherRun: number;
  /** Organizations skipped because their claim could not be recorded
   *  (onClaimUnavailable 'skip'; always 0 otherwise). Nothing was written for
   *  them, so they go first on the next run. */
  claimUnavailable: number;
  /** Organizations not started: the deadline or the budget came first. They
   *  go first on the next run. */
  leftForNextRun: number;
  /** True when the leftovers were left by the deadline (not the budget). */
  stoppedAtDeadline: boolean;
  /** Organizations whose attempts have now ended without success this many
   *  times in a row or more (REPEATED_FAILURES). */
  failingRepeatedly: number;
  /** 'attempts' normally; 'clock' when the attempt records could not be read
   *  and the run went in rotateByClock order. */
  orderedBy: 'attempts' | 'clock';
  /** Organizations moved to the front because their last attempt was their
   *  first failure (retryFirstOnce, at most RETRY_FIRST_LIMIT). */
  promoted: number;
}

/** Attempts in a row without success from which an organization is counted
 *  in failingRepeatedly. */
export const REPEATED_FAILURES = 3;

/**
 * The shared loop of a scheduled job that visits organizations one at a
 * time: least recently attempted first (this job's rows in
 * cron_sweep_attempts), each organization's attempt stamped as it starts
 * (and, with `holdMs`, claimed: see cronAttemptClaimer), no organization
 * started once `deadlineAt` has passed or `stopWhen` says so, and a warning
 * to the error reporter (`<tag>.deadline`) when the deadline left some.
 *
 * `work(orgId, index)` does one organization (index: its place in this run's
 * order, from 0) and says how it ended. A throw is reported (`<tag>.org`),
 * counted as a failure, and never stops the rest. One at a time, as these
 * jobs always ran: the fairness comes from the order, not from parallel work.
 *
 * An organization whose last attempt was its first failure (retryFirstOnce,
 * at most RETRY_FIRST_LIMIT a run) goes to the front: an attempt killed at
 * maxDuration leaves exactly that, and at the front it gets the whole run.
 *
 * With `holdMs`, `onClaimUnavailable` says what to do with an organization
 * whose claim cannot be recorded: 'run' it unclaimed (the default, for a job
 * with its own atomic guard) or 'skip' it for this run after one retry
 * (counted in `claimUnavailable`), see cronAttemptClaimer. A run that claims
 * nothing and skips at least one organization (the rest, if any, held by
 * another run) reports it as an error (`<tag>.claims_down`).
 *
 * When the attempt records cannot be read the run is reported
 * (`<tag>.attempts`) and goes in rotateByClock order (`slotMs`: the job's
 * cadence), so even then a cut does not fall on the same organizations every
 * run.
 */
export async function sweepOrganizations<V>(
  admin: ReturnType<typeof createAdminClient>,
  opts: {
    job: CronSweepJob;
    tag: string;
    orgIds: readonly string[];
    deadlineAt: number;
    slotMs: number;
    holdMs?: number;
    /** Only with `holdMs`. Default 'run'. */
    onClaimUnavailable?: OnClaimUnavailable;
    /** The wait before a claim's retry with 'skip' (default CLAIM_RETRY_MS). */
    retryDelayMs?: number;
    stopWhen?: () => boolean;
  },
  work: (orgId: string, index: number) => Promise<OrgWorkOutcome<V>>,
): Promise<OrgSweepOutcome<V>> {
  let attempts: CronAttempts | null = null;
  try {
    attempts = await readCronAttempts(admin, opts.job);
  } catch (err) {
    void reportError(err, {
      tag: `${opts.tag}.attempts`,
      level: 'warning',
      extra: { step: 'read' },
    });
  }
  const { order: ordered, promoted } = retryFirstOnce(
    sweepOrder(opts.orgIds, attempts?.lastAttempt ?? null, {
      now: Date.now(),
      slotMs: opts.slotMs,
    }),
    attempts?.failures ?? new Map<string, number>(),
  );
  const failuresBefore = attempts?.failures ?? new Map<string, number>();
  const reportTag = `${opts.tag}.attempts`;
  const claimer =
    opts.holdMs !== undefined
      ? cronAttemptClaimer(admin, opts.job, {
          failuresBefore,
          reportTag,
          holdMs: opts.holdMs,
          onClaimUnavailable: opts.onClaimUnavailable,
          retryDelayMs: opts.retryDelayMs,
        })
      : null;
  const recorder = claimer
    ? null
    : cronAttemptRecorder(admin, opts.job, { failuresBefore, reportTag });

  const done: Array<{ orgId: string; value: V }> = [];
  let threw = 0;
  let failed = 0;
  let heldByAnotherRun = 0;
  let claimUnavailable = 0;
  let failingRepeatedly = 0;
  const sweep = await sweepUntilDeadline(
    ordered,
    { concurrency: 1, deadlineAt: opts.deadlineAt, stopWhen: opts.stopWhen },
    async (orgId, index) => {
      // Stamped (and claimed) before the organization's first read.
      const finish = claimer ? await claimer.claim(orgId) : recorder!.start(orgId);
      if (finish === null) {
        heldByAnotherRun += 1;
        return;
      }
      if (finish === CLAIM_UNAVAILABLE) {
        claimUnavailable += 1;
        return;
      }
      let result: CronAttemptResult;
      try {
        const outcome = await work(orgId, index);
        done.push({ orgId, value: outcome.value });
        result = outcome.result;
      } catch (e) {
        threw += 1;
        void reportError(e, { tag: `${opts.tag}.org`, extra: { orgId } });
        result = 'failure';
      }
      if (result === 'failure') failed += 1;
      if ((await finish(result)) >= REPEATED_FAILURES) failingRepeatedly += 1;
    },
  );
  if (claimUnavailable > 0 && claimUnavailable === sweep.started - heldByAnotherRun) {
    // Nothing this run tried was claimed: every organization it started was
    // skipped, apart from those another run holds. The claims are down for
    // everyone, not one passing error. An error, not a warning.
    const code = claimer?.unavailableCode || 'unknown';
    void reportError(
      new Error(
        `Scheduled job skipped every organization it tried: claims could not be recorded (code ${code})`,
      ),
      {
        tag: `${opts.tag}.claims_down`,
        level: 'error',
        extra: { job: opts.job, code, skipped: claimUnavailable },
      },
    );
  }
  const stoppedAtDeadline = sweep.leftForNextRun > 0 && Date.now() >= opts.deadlineAt;
  if (stoppedAtDeadline) {
    void reportError(new Error('Scheduled job stopped at the run deadline'), {
      tag: `${opts.tag}.deadline`,
      level: 'warning',
      extra: {
        organizations: ordered.length,
        started: sweep.started,
        leftForNextRun: sweep.leftForNextRun,
      },
    });
  }
  return {
    done,
    failed,
    threw,
    heldByAnotherRun,
    claimUnavailable,
    leftForNextRun: sweep.leftForNextRun,
    stoppedAtDeadline,
    failingRepeatedly,
    orderedBy: attempts ? 'attempts' : 'clock',
    promoted,
  };
}
