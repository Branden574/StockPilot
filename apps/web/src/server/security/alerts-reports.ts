import 'server-only';

import { reportError } from '@/lib/error-reporter';

import { ALERT_REPORT_GAP_HOURS } from '@stockpilot/core';

/**
 * EVERY REPORT OF THE TWO SECURITY ALERT JOBS (the alert job every 10
 * minutes, server/security/alerts-job.ts; the daily job,
 * app/api/cron/security-summary) goes through reportAlertJob, and nowhere
 * else (alerts-record-only.guard.test.ts: neither job may import the error
 * reporter itself). Two promises:
 *
 *   1. A GIVEN TAG AT MOST ONCE IN 6 HOURS on this server instance
 *      (ALERT_REPORT_GAP_HOURS, the database's own gap): a deployment
 *      problem or an answer this build cannot read would otherwise post on
 *      every run, 144 times a day. The one report the database gates itself
 *      ("the job is failing": the heartbeat's report_now, at most once in 6
 *      hours across every instance) is sent when, and only when, the
 *      database says so: its answer is the authority, not this instance's
 *      memory (a new instance would forget, and two instances would each
 *      send).
 *   2. NOTHING BUT A FIXED TAG, COUNTS AND CODES. The message is the tag's
 *      own fixed sentence. `counts` are whole numbers. `codes` are short
 *      codes of this build's own vocabulary (a SQLSTATE, a refusal word, a
 *      function's name, the place an answer's shape differs), each checked
 *      against CODE_RE: anything else is sent as "not_a_code". A key that is
 *      not a lower-case word is dropped. No organization, key, address,
 *      database text or value from an answer can travel in a report.
 *
 * Never throws: a report that cannot be sent is dropped (the job's log line
 * still says what happened).
 */

/** The reports, each with its level and its one fixed sentence. */
export const ALERT_JOB_REPORTS = {
  'cron.security-alerts.cannot_call': {
    level: 'error',
    message:
      'The security alert job cannot call one of its database functions: a deployment problem',
  },
  'cron.security-alerts.start_unreadable': {
    level: 'error',
    message: "The security alert job could not read its heartbeat's start",
  },
  'cron.security-alerts.start_refused': {
    level: 'error',
    message: "The security alert job's start was refused: a deployment problem",
  },
  'cron.security-alerts.inputs_unreadable': {
    level: 'warning',
    message: 'The security alert job could not read its inputs',
  },
  'cron.security-alerts.inputs_no_state': {
    level: 'error',
    message: "The security alert job's inputs were refused (no_state): a deployment problem",
  },
  'cron.security-alerts.failing': {
    level: 'error',
    message: 'The security alert job has missed or failed runs in a row',
    gate: 'database',
  },
  'cron.security-alerts.channel_on': {
    level: 'warning',
    message:
      'A security alert channel is on, but this release sends nothing: handed-out alerts were recorded as skipped',
  },
  'cron.security-alerts.unexpected': {
    level: 'warning',
    message: 'The security alert job had answers it does not expect',
  },
  'cron.security-summary.baseline_failed': {
    level: 'warning',
    message: "The security alerts' baseline could not be computed",
  },
  'cron.security-summary.baseline_unreadable': {
    level: 'warning',
    message: "The security alerts' baseline answered a shape this build does not know",
  },
  'cron.security-summary.baseline_refused': {
    level: 'warning',
    message: "The security alerts' baseline was refused",
  },
  'cron.security-summary.baseline_no_state': {
    level: 'error',
    message: "The security alerts' baseline was refused (no_state): a deployment problem",
  },
} as const satisfies Record<
  string,
  { level: 'error' | 'warning'; message: string; gate?: 'database' }
>;
export type AlertJobReportTag = keyof typeof ALERT_JOB_REPORTS;

/** A tag's least gap on one instance (the database's report_now uses the same). */
export const ALERT_JOB_REPORT_GAP_MS = ALERT_REPORT_GAP_HOURS * 3_600_000;

/** A key of counts or codes: a lower-case word. */
const KEY_RE = /^[a-z][A-Za-z0-9_]{0,47}$/;
/** A code: letters, digits, underscores and dots, 64 at most (a function's name, a SQLSTATE, a word). */
const CODE_RE = /^[A-Za-z0-9_.]{1,64}$/;
/** At most this many counts and codes in one report. */
const MOST_KEYS = 24;

export interface AlertJobReportData {
  counts?: Readonly<Record<string, number>>;
  codes?: Readonly<Record<string, string>>;
}

/** The place a reader found an answer's shape different, as a code: no index, no free text. */
export function alertWhereCode(where: string): string {
  const code = where
    .replace(/\[\d+\]/g, '')
    .replace(/[^A-Za-z0-9_.]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return CODE_RE.test(code) ? code : 'not_a_code';
}

/** What a report may carry: whole-number counts and checked codes, under word keys. */
function extraOf(data: AlertJobReportData): Record<string, string | number> {
  const extra: Record<string, string | number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(data.counts ?? {})) {
    if (n >= MOST_KEYS || !KEY_RE.test(k) || !Number.isSafeInteger(v) || v < 0) continue;
    extra[k] = v;
    n += 1;
  }
  for (const [k, v] of Object.entries(data.codes ?? {})) {
    if (n >= MOST_KEYS || !KEY_RE.test(k) || k in extra) continue;
    extra[k] = typeof v === 'string' && CODE_RE.test(v) ? v : 'not_a_code';
    n += 1;
  }
  return extra;
}

/** When each tag was last sent on this instance. */
const lastSent = new Map<AlertJobReportTag, number>();

/**
 * Sends one report, or holds it: 'held' when its tag went out on this
 * instance less than 6 hours ago, or, for a tag the database gates, when
 * the database did not say to report now. Never throws.
 */
export async function reportAlertJob(
  tag: AlertJobReportTag,
  data: AlertJobReportData = {},
  databaseSaysReportNow = false,
): Promise<'sent' | 'held'> {
  const spec: { level: 'error' | 'warning'; message: string; gate?: 'database' } =
    ALERT_JOB_REPORTS[tag];
  const now = Date.now();
  if (spec.gate === 'database') {
    if (!databaseSaysReportNow) return 'held';
  } else {
    const last = lastSent.get(tag);
    if (last !== undefined && now - last < ALERT_JOB_REPORT_GAP_MS) return 'held';
  }
  lastSent.set(tag, now);
  try {
    await reportError(new Error(spec.message), { tag, level: spec.level, extra: extraOf(data) });
  } catch {
    // A report that could not be sent is dropped.
  }
  return 'sent';
}

/** Test only: no tag sent yet on this instance. */
export function __resetAlertJobReportsForTests(): void {
  lastSent.clear();
}
