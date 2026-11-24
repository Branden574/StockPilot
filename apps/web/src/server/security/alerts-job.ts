import 'server-only';

import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

import {
  ADMIN_EMAILS_MOST,
  ALERT_EXPECTED_CLAIM_REFUSALS,
  dueReminderStep,
  nextStartKey,
  planSecurityAlerts,
  readSecurityAlertClaim,
  readSecurityAlertHeartbeatFinish,
  readSecurityAlertHeartbeatStart,
  readSecurityAlertInputs,
  readSecurityAlertResult,
  recordOnlyResult,
  alertReminderKey,
  type AlertClaimAnswer,
  type AlertClaimAsk,
  type AlertSpikeHeld,
  type SecurityAlertInputs,
  type SecurityAlertPlan,
} from '@stockpilot/core';

/**
 * THE SECURITY ALERT JOB (security tools part 5, stage 4a: RECORD ONLY). The
 * cron route app/api/cron/security-alerts calls runSecurityAlerts every 10
 * minutes. NOTHING IS SENT: this module has no email sender, no push sender
 * and no way to turn a switch on (alerts-job.guard.test.ts pins that it
 * imports none and calls none of the functions that would).
 *
 * THE ORDER, exactly as the database half's contract gives it
 * (part-5-alerts-db CONTRACT.md, "What the job does, in order"):
 *   1. heartbeat('start'): the run's id. 55P03: another run is mid-way, stop
 *      without a finish. no_state: a deployment bug, reported. report_now:
 *      three runs in a row were missed or failed, reported once through the
 *      app's error reporter (the database says it at most once in 6 hours).
 *   2. inputs(). Refused, failed or 57014: finish(false) and stop.
 *   3. SERIOUS FLAGS FIRST, one at a time, each claimed and closed before the
 *      next: (a) every serious retry, (b) every serious flag. Nothing of the
 *      volume and record rules runs before every serious flag is done.
 *   4. The volume and record retries (the held notices' among them).
 *   5. and 6. The rules (core's planSecurityAlerts, from the inputs alone):
 *      for each condition a start, its due reminder or its end. Never an end
 *      from a partial read. A start answered state_ended is claimed again
 *      only with a newer judged bucket, never with the refused key; a start
 *      answered already_open takes open_key as the state (its due reminder).
 *   7. What the claim hands out is CLOSED AS RECORD ONLY: in this release
 *      nothing is sent, so for each channel an alert was handed out for (only
 *      possible with a switch on) the result is recorded as `skipped` for
 *      every recipient, and a serious flag's push that so reached no one is
 *      owed its email (email_floor_due): its email is recorded as skipped too.
 *      A held notice in a claim's answer is closed the same way. That is
 *      reported once per run (a switch is on, and this release sends
 *      nothing). A record_only claim hands out nothing and needs no result.
 *   9. heartbeat('finish', ok, partial): partial when the read was shortened
 *      or a list of it was full (the console: "could not check fully").
 *   (8, the daily steps, are the summary job's baseline and the retention
 *   job's purge.)
 *
 * EVERY CALL HAS A TIME LIMIT and the run has its own deadline
 * (SECURITY_ALERTS_RUN_DEADLINE_MS) inside the route's 60 s: no claim starts
 * after the deadline less SECURITY_ALERTS_FINISH_RESERVE_MS, so the finish
 * always has its time, and the reports are waited for
 * SECURITY_ALERTS_REPORTS_MAX_MS at most. A busy claim (55P03), a failed or
 * late call, or an answer this build cannot read stops the claims (the next
 * run picks up, serious flags first again) and the run finishes not ok. Once
 * the start answered, the finish is always asked for.
 *
 * TWO RUNS AT ONCE ARE SAFE by the database: each alert is one row (the
 * second run's claim is a duplicate), a retry is handed out once, and the
 * second run's start makes the first run's finish not_the_latest_run, which
 * this job takes as an answer.
 *
 * NEVER THROWS, and what it answers and logs is counts and fixed words only:
 * never the run's id, an organization, a key's subject or a database's text.
 */

export const SECURITY_ALERTS_TAG = 'cron.security-alerts';
/** A run starts no call after this long, and cuts any call at it (the route allows 60 s). */
export const SECURITY_ALERTS_RUN_DEADLINE_MS = 50_000;
/** No claim starts within this long of the deadline: the finish always has its time. */
export const SECURITY_ALERTS_FINISH_RESERVE_MS = 6_000;
/** One claim, result or heartbeat call, this long at most (the lock waits 2 s). */
export const SECURITY_ALERTS_CALL_TIMEOUT_MS = 5_000;
/** The inputs read (the database cancels it at 5 s; its answer can be large). */
export const SECURITY_ALERTS_INPUTS_TIMEOUT_MS = 10_000;
/** How long a run waits for its reports, all sent at once. With the deadline above, a run ends inside 54 s. */
export const SECURITY_ALERTS_REPORTS_MAX_MS = 4_000;
/** A call is not started with less time than this left. */
const MIN_CALL_MS = 1_000;
/** The wait before the finish is asked once more after a busy answer. */
const FINISH_RETRY_MS = 500;

const FN = {
  heartbeat: 'platform_security_alert_heartbeat',
  inputs: 'platform_security_alert_inputs',
  claim: 'platform_security_alert_claim',
  result: 'platform_security_alert_result',
} as const;

type AdminClient = ReturnType<typeof createAdminClient>;
type FnName = (typeof FN)[keyof typeof FN];

/**
 * Each function called by its name written out, so the guards that read
 * every .rpc( call (rpc-active-organization, organization-create-sites,
 * alerts-record-only) can see which function it is.
 */
function rpcOf(client: AdminClient, fn: FnName, args: Record<string, unknown> | undefined) {
  switch (fn) {
    case 'platform_security_alert_heartbeat':
      return client.rpc('platform_security_alert_heartbeat', args);
    case 'platform_security_alert_inputs':
      return client.rpc('platform_security_alert_inputs');
    case 'platform_security_alert_claim':
      return client.rpc('platform_security_alert_claim', args);
    case 'platform_security_alert_result':
      return client.rpc('platform_security_alert_result', args);
  }
}

type Outcomes = {
  claims: number;
  new: number;
  retry: number;
  duplicate: number;
  not_sent: number;
  refused: number;
};
const noOutcomes = (): Outcomes => ({
  claims: 0,
  new: 0,
  retry: 0,
  duplicate: 0,
  not_sent: 0,
  refused: 0,
});

export type SecurityAlertsStop =
  | 'time_limit'
  | 'busy'
  | 'call_failed'
  | 'unreadable'
  | 'inputs_refused'
  | 'inputs_failed'
  | 'unexpected';

/** The run's answer and its one log line: counts and fixed words only. */
export interface SecurityAlertsRunSummary {
  /** False: no run was started (another run held the alerts, or the start failed or was refused). */
  ran: boolean;
  skipped: 'another_run' | 'start_failed' | 'start_refused' | null;
  ok: boolean;
  /** The read was shortened or one of its lists was full (the console: "could not check fully"). */
  partial: boolean;
  stop: SecurityAlertsStop | null;
  serious: Outcomes;
  retries: Outcomes;
  conditions: Outcomes;
  /** Claims a channel was handed out for: recorded as skipped (record only). */
  closedRecordOnly: number;
  /** Held notices in claims' answers: closed the same way. */
  notices: number;
  /** Claim refusals this build does not expect, and answers it could not read, by word. */
  unexpected: Record<string, number>;
  /** States whose start was refused state_ended and had no newer bucket: left to the next run. */
  leftToNextRun: number;
  spikeHeld: AlertSpikeHeld;
  judgedBucket: string | null;
  /** When the read was shortened: serious flags dated before this could not be checked. */
  shortenedFrom: string | null;
  markedNotSent: number;
  missedRuns: number;
  failuresInARow: number | null;
  reportNow: boolean;
  finish:
    'recorded' | 'not_the_latest_run' | 'already_finished' | 'refused' | 'failed' | 'not_asked';
}

/* ───────────────────────────────── calls ───────────────────────────────── */

class CallTimeout extends Error {
  constructor() {
    super('call timed out');
    this.name = 'CallTimeout';
  }
}

/** Runs `start` with a time limit; past `ms` its signal is aborted and the wait ends with CallTimeout. */
async function within<T>(ms: number, start: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CallTimeout());
    }, ms);
  });
  deadline.catch(() => undefined);
  try {
    const work = Promise.resolve(start(controller.signal));
    work.catch(() => undefined);
    return await Promise.race([work, deadline]);
  } catch (e) {
    if (controller.signal.aborted) throw new CallTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

type FailureKind =
  'busy' | 'cancelled' | 'not_allowed' | 'missing' | 'timeout' | 'out_of_time' | 'error';
interface Failure {
  kind: FailureKind;
  code: string;
}
type Called = { ok: true; data: unknown } | { ok: false; failure: Failure };

/** A database error's code, as a short code only; never its text. */
function codeOf(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : 'no_code';
}

function failureOf(error: unknown): Failure {
  const code = codeOf(error);
  if (code === '55P03') return { kind: 'busy', code };
  if (code === '57014') return { kind: 'cancelled', code };
  if (code === '42501') return { kind: 'not_allowed', code };
  if (code === '42883' || code === 'PGRST202') return { kind: 'missing', code };
  return { kind: 'error', code };
}

interface Report {
  message: string;
  level: 'error' | 'warning';
  extra: Record<string, string | number | boolean>;
}

/** Sends a run's reports at once and waits SECURITY_ALERTS_REPORTS_MAX_MS at most. Never throws. */
async function flushReports(reports: readonly Report[]): Promise<void> {
  if (reports.length === 0) return;
  const sent = Promise.all(
    reports.map(async ({ message, level, extra }) => {
      try {
        await reportError(new Error(message), { tag: SECURITY_ALERTS_TAG, level, extra });
      } catch {
        // A report that could not be sent is dropped: the run still answers.
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SECURITY_ALERTS_REPORTS_MAX_MS);
  });
  try {
    await Promise.race([sent, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many recipients a channel has, for the record-only result: the
 * addresses on the platform-admin allowlist (the first ADMIN_EMAILS_MOST, as
 * the push recipients' read takes them). A count only: no address is read
 * into a result, a log line or a report.
 */
function recipientCount(): number {
  const list = env.STOCKPILOT_PLATFORM_ADMIN_EMAILS ?? '';
  return Math.min(new Set(list.split(',').filter(Boolean)).size, ADMIN_EMAILS_MOST);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ───────────────────────────────── the run ───────────────────────────────── */

export async function runSecurityAlerts(): Promise<SecurityAlertsRunSummary> {
  const started = Date.now();
  const deadline = started + SECURITY_ALERTS_RUN_DEADLINE_MS;
  const claimsUntil = deadline - SECURITY_ALERTS_FINISH_RESERVE_MS;
  const reports: Report[] = [];
  const summary: SecurityAlertsRunSummary = {
    ran: false,
    skipped: null,
    ok: false,
    partial: false,
    stop: null,
    serious: noOutcomes(),
    retries: noOutcomes(),
    conditions: noOutcomes(),
    closedRecordOnly: 0,
    notices: 0,
    unexpected: {},
    leftToNextRun: 0,
    spikeHeld: null,
    judgedBucket: null,
    shortenedFrom: null,
    markedNotSent: 0,
    missedRuns: 0,
    failuresInARow: null,
    reportNow: false,
    finish: 'not_asked',
  };
  let admin: AdminClient | null = null;
  const deployment = new Set<string>();

  /** One call with its own limit, cut at `until`. Never throws. */
  const call = async (
    fn: FnName,
    args: Record<string, unknown> | undefined,
    ownMs: number,
    until: number,
  ): Promise<Called> => {
    const left = until - Date.now();
    if (left < MIN_CALL_MS)
      return { ok: false, failure: { kind: 'out_of_time', code: 'deadline' } };
    const ms = Math.min(ownMs, left);
    try {
      admin ??= createAdminClient();
      const client = admin;
      const { data, error } = (await within(ms, (signal) =>
        rpcOf(client, fn, args).abortSignal(signal),
      )) as { data: unknown; error: unknown };
      if (error) {
        const failure = failureOf(error);
        // The function missing or not ours to call: the code is ahead of the
        // migration, or a grant is wrong. Loud, once per run and function.
        if ((failure.kind === 'missing' || failure.kind === 'not_allowed') && !deployment.has(fn)) {
          deployment.add(fn);
          reports.push({
            message: `The security alert job cannot call ${fn} (${failure.code}): a deployment problem`,
            level: 'error',
            extra: { fn, code: failure.code },
          });
        }
        return { ok: false, failure };
      }
      return { ok: true, data };
    } catch (e) {
      if (e instanceof CallTimeout) {
        return {
          ok: false,
          failure: { kind: ms < ownMs ? 'out_of_time' : 'timeout', code: 'timeout' },
        };
      }
      return { ok: false, failure: { kind: 'error', code: codeOf(e) } };
    }
  };

  const unexpected = (word: string) => {
    summary.unexpected[word] = (summary.unexpected[word] ?? 0) + 1;
  };
  const stopFor = (failure: Failure): SecurityAlertsStop =>
    failure.kind === 'busy'
      ? 'busy'
      : failure.kind === 'out_of_time'
        ? 'time_limit'
        : 'call_failed';
  let reportedFailing = false;
  const reportFailing = (failures: number, step: 'start' | 'finish') => {
    if (reportedFailing) return;
    reportedFailing = true;
    reports.push({
      message: `The security alert job has missed or failed ${failures} runs in a row`,
      level: 'error',
      extra: { failuresInARow: failures, step },
    });
  };

  let runId: string | null = null;
  try {
    // ── 1. The start.
    const begun = await call(
      FN.heartbeat,
      { p_step: 'start' },
      SECURITY_ALERTS_CALL_TIMEOUT_MS,
      claimsUntil,
    );
    if (!begun.ok) {
      summary.skipped = begun.failure.kind === 'busy' ? 'another_run' : 'start_failed';
      return summary;
    }
    const start = readSecurityAlertHeartbeatStart(begun.data);
    if (!start.ok) {
      summary.skipped = 'start_failed';
      reports.push({
        message: `The security alert job could not read its heartbeat's start (${start.where})`,
        level: 'error',
        extra: { where: start.where.slice(0, 80) },
      });
      return summary;
    }
    if (start.refused !== null) {
      summary.skipped = 'start_refused';
      reports.push({
        message: `The security alert job's start was refused (${start.refused}): a deployment problem`,
        level: 'error',
        extra: { refused: start.refused },
      });
      return summary;
    }
    runId = start.value.runId;
    summary.ran = true;
    summary.markedNotSent = start.value.markedNotSent;
    summary.missedRuns = start.value.missedRuns;
    summary.failuresInARow = start.value.failuresInARow;
    if (start.value.reportNow) {
      summary.reportNow = true;
      reportFailing(start.value.failuresInARow, 'start');
    }

    // ── 2. The inputs.
    const read = await call(FN.inputs, undefined, SECURITY_ALERTS_INPUTS_TIMEOUT_MS, claimsUntil);
    let inputs: SecurityAlertInputs | null = null;
    if (!read.ok) {
      summary.stop = read.failure.kind === 'out_of_time' ? 'time_limit' : 'inputs_failed';
    } else {
      const parsed = readSecurityAlertInputs(read.data);
      if (!parsed.ok) {
        summary.stop = 'unreadable';
        unexpected('inputs_unreadable');
        reports.push({
          message: `The security alert job could not read its inputs (${parsed.where})`,
          level: 'warning',
          extra: { where: parsed.where.slice(0, 80) },
        });
      } else if (parsed.refused !== null) {
        summary.stop = 'inputs_refused';
        if (parsed.refused === 'no_state') {
          reports.push({
            message:
              "The security alert job's inputs were refused (no_state): a deployment problem",
            level: 'error',
            extra: { refused: parsed.refused },
          });
        }
      } else {
        inputs = parsed.value;
      }
    }

    if (inputs !== null) {
      const plan: SecurityAlertPlan = planSecurityAlerts(inputs);
      summary.partial = plan.partial;
      summary.spikeHeld = plan.spikeHeld;
      summary.judgedBucket = plan.judgedBucketKey;
      summary.shortenedFrom = plan.shortenedFrom;
      const recipients = recipientCount();

      /** Records a handed-out alert's result as record only. False: the run must stop. */
      const closeRecordOnly = async (
        id: string,
        attempt: number,
        push: boolean,
        email: boolean,
      ): Promise<boolean> => {
        const skipped = recordOnlyResult(recipients);
        const first = await call(
          FN.result,
          {
            p_id: id,
            p_attempt: attempt,
            p_push_result: push ? skipped : null,
            p_email_result: email ? skipped : null,
          },
          SECURITY_ALERTS_CALL_TIMEOUT_MS,
          claimsUntil,
        );
        if (!first.ok) {
          summary.stop = stopFor(first.failure);
          return false;
        }
        let answer = readSecurityAlertResult(first.data);
        // A serious flag handed out by push alone whose push reached no one is
        // owed its email: recorded with both results (both skipped here).
        if (answer.ok && answer.refused === 'email_floor_due') {
          const again = await call(
            FN.result,
            { p_id: id, p_attempt: attempt, p_push_result: skipped, p_email_result: skipped },
            SECURITY_ALERTS_CALL_TIMEOUT_MS,
            claimsUntil,
          );
          if (!again.ok) {
            summary.stop = stopFor(again.failure);
            return false;
          }
          answer = readSecurityAlertResult(again.data);
        }
        if (!answer.ok) {
          unexpected('result_unreadable');
          summary.stop = 'unreadable';
          return false;
        }
        if (answer.refused !== null) unexpected(`result_${answer.refused}`);
        else summary.closedRecordOnly += 1;
        return true;
      };

      /** One claim and what it hands out. Null: the run must stop. */
      const claim = async (
        ask: AlertClaimAsk,
        tally: Outcomes,
      ): Promise<AlertClaimAnswer | null> => {
        const made = await call(
          FN.claim,
          {
            p_rule: ask.rule,
            p_subject: ask.subject,
            p_event_key: ask.eventKey,
            p_phase: ask.phase,
            p_counts: ask.counts,
          },
          SECURITY_ALERTS_CALL_TIMEOUT_MS,
          claimsUntil,
        );
        if (!made.ok) {
          summary.stop = stopFor(made.failure);
          return null;
        }
        const answer = readSecurityAlertClaim(made.data);
        if (!answer.ok) {
          // Whether it handed anything out is not known: stop (its row, if any, is retried).
          unexpected('claim_unreadable');
          summary.stop = 'unreadable';
          return null;
        }
        const c = answer.claim;
        tally.claims += 1;
        tally[c.outcome] += 1;
        if (c.refused !== null && !ALERT_EXPECTED_CLAIM_REFUSALS.includes(c.refused)) {
          unexpected(`claim_${c.refused}`);
        }
        if ((c.outcome === 'new' || c.outcome === 'retry') && (c.push || c.email)) {
          if (!(await closeRecordOnly(c.id!, c.attempt!, c.push, c.email))) return null;
        }
        if (c.notice !== null) {
          summary.notices += 1;
          if (!(await closeRecordOnly(c.notice.id, 1, c.notice.push, c.notice.email))) return null;
        }
        return c;
      };

      const claimAll = async (
        asks: readonly AlertClaimAsk[],
        tally: Outcomes,
      ): Promise<boolean> => {
        for (const ask of asks) if ((await claim(ask, tally)) === null) return false;
        return true;
      };

      /** Steps 5 and 6: a condition's claim, with the two answers that name another key. */
      const claimCondition = async (ask: AlertClaimAsk): Promise<boolean> => {
        const answer = await claim(ask, summary.conditions);
        if (answer === null) return false;
        if (ask.phase !== 'started' || answer.outcome !== 'refused') return true;
        if (answer.refused === 'state_ended') {
          const newer = nextStartKey(ask.eventKey, plan.judgedBucketKey);
          if (newer === null) {
            summary.leftToNextRun += 1;
            return true;
          }
          return (await claim({ ...ask, eventKey: newer }, summary.conditions)) !== null;
        }
        if (answer.refused === 'already_open' && answer.openKey !== null) {
          // The open state is open_key's: its due reminder, if any (a duplicate when claimed already).
          const step = dueReminderStep(answer.openKey, inputs!.nowMs, []);
          if (step === null) return true;
          return (
            (await claim(
              { ...ask, eventKey: alertReminderKey(answer.openKey, step), phase: 'reminder' },
              summary.conditions,
            )) !== null
          );
        }
        return true;
      };

      // ── 3. Serious flags first: (a) the retries, (b) the flags.
      let going = await claimAll(plan.seriousRetries, summary.serious);
      if (going) going = await claimAll(plan.serious, summary.serious);
      // ── 4. The volume and record retries.
      if (going) going = await claimAll(plan.retries, summary.retries);
      // ── 5 and 6. The conditions.
      if (going) {
        for (const ask of plan.conditions) {
          if (!(await claimCondition(ask))) break;
        }
      }
    }
  } catch {
    // Nothing above throws by design; if something did, the run is not ok and is finished.
    if (summary.stop === null) summary.stop = 'unexpected';
    unexpected('thrown');
  } finally {
    // An answer this build does not expect makes the run not ok: it could not check as written.
    if (summary.stop === null && Object.keys(summary.unexpected).length > 0)
      summary.stop = 'unexpected';
    // ── 9. The finish, whenever the start answered.
    if (runId !== null) {
      summary.ok = summary.stop === null;
      const args = {
        p_step: 'finish',
        p_run_id: runId,
        p_ok: summary.ok,
        p_partial: summary.partial,
      };
      let done = await call(FN.heartbeat, args, SECURITY_ALERTS_CALL_TIMEOUT_MS, deadline);
      if (
        !done.ok &&
        done.failure.kind === 'busy' &&
        deadline - Date.now() > FINISH_RETRY_MS + MIN_CALL_MS
      ) {
        await pause(FINISH_RETRY_MS);
        done = await call(FN.heartbeat, args, SECURITY_ALERTS_CALL_TIMEOUT_MS, deadline);
      }
      if (!done.ok) {
        summary.finish = 'failed';
      } else {
        const finish = readSecurityAlertHeartbeatFinish(done.data);
        if (!finish.ok) {
          summary.finish = 'failed';
          unexpected('finish_unreadable');
        } else if (
          finish.refused === 'not_the_latest_run' ||
          finish.refused === 'already_finished'
        ) {
          // An overlapping run started after this one: its finish is the one that counts.
          summary.finish = finish.refused;
        } else if (finish.refused !== null) {
          summary.finish = 'refused';
          unexpected(`finish_${finish.refused}`);
        } else {
          summary.finish = 'recorded';
          summary.failuresInARow = finish.value.failuresInARow;
          if (finish.value.reportNow) {
            summary.reportNow = true;
            reportFailing(finish.value.failuresInARow, 'finish');
          }
        }
      }
    }
    if (summary.closedRecordOnly > 0 || summary.notices > 0) {
      reports.push({
        message: `A security alert channel is on, but this release sends nothing: ${summary.closedRecordOnly} handed-out alerts were recorded as skipped`,
        level: 'warning',
        extra: { closed: summary.closedRecordOnly, notices: summary.notices },
      });
    }
    const unexpectedWords = Object.entries(summary.unexpected);
    if (unexpectedWords.length > 0) {
      reports.push({
        message: 'The security alert job had answers it does not expect',
        level: 'warning',
        extra: {
          answers: unexpectedWords
            .map(([w, n]) => `${w}:${n}`)
            .join(',')
            .slice(0, 300),
        },
      });
    }
    await flushReports(reports);
  }
  return summary;
}
