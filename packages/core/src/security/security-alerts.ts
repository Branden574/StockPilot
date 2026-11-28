/**
 * THE PLATFORM CONSOLE'S SECURITY ALERTS (security tools part 5, stage 4a:
 * record only). Pure: no I/O.
 *
 * What lives here:
 *   - the constants of the database half, exactly as its contract gives them
 *     (part-5-alerts-db CONTRACT.md, migration 0480): rules, phases,
 *     dispositions, the thresholds with their defaults and ranges, the
 *     buckets and windows, the result codes;
 *   - readers of every answer the job and the console read (inputs, claim,
 *     result, heartbeat, baseline, list): a key this build does not know is
 *     ignored (a later additive change); a key it reads that is missing or
 *     of another type is "could not check", never an empty answer;
 *   - THE RULES, as functions over the inputs' answer: a serious flag (one
 *     per reason and UTC hour, a flagged flood row among them), guessing
 *     aimed at one organization, a spike against the stored high mark (held
 *     while there is no baseline or the record is younger than the learning
 *     days), and record trouble; and THE STATE MODEL that turns them into
 *     claims (a start, reminders at 1, 6 and 24 hours, an end), with their
 *     keys built from the events, never from a clock;
 *   - every word the console's alerts page says.
 *
 * WHAT THE RULES PROMISE (each a test by name in security-alerts.test.ts):
 *   - serious flags first: every serious retry and every serious flag is
 *     claimed before any volume or record alert, whatever the input holds;
 *   - one state per rule and subject: a condition that lasts makes one start,
 *     at most three reminders (never two in one run) and one end, so a scan
 *     that lasts 12 hours claims at most 4 alerts that could push (an end
 *     never pushes); the database's budgets bound the rest;
 *   - an end only after the condition has been quiet for
 *     ALERT_END_QUIET_BUCKETS whole buckets, and never from a partial read
 *     (a condition may only be out of sight);
 *   - a lost run never loses an alert: every run judges the last
 *     ALERT_LOOK_BACK_BUCKETS whole buckets, so the next run claims what a
 *     failed, missed or cut run would have claimed, under the same key;
 *   - a key from the events: a serious flag's is its reason and the event's
 *     UTC hour (as the inputs give it); a state's start is the oldest bucket
 *     of the look-back where the condition holds (its own bucket); a
 *     reminder is the state's key and its step.
 */

import { securityEventReasonLabel, SECURITY_EVENT_REASON_RE } from './security-events';
import { securityResponseCardIdFor, type SecurityResponseCardId } from './security-response';

/* ───────────────────────── the database's constants ───────────────────────── */

/** Rule -> class. alerts_held is made by the claim itself (the job never claims a new one). */
export const ALERT_RULES = {
  serious_flag: 'serious',
  spike: 'volume',
  aimed_guessing: 'volume',
  record_trouble: 'record',
  alerts_held: 'notice',
} as const;
export type AlertRule = keyof typeof ALERT_RULES;
export type AlertClass = (typeof ALERT_RULES)[AlertRule];
export const ALERT_RULE_NAMES = Object.keys(ALERT_RULES) as AlertRule[];
/** The rules that are states (a start, reminders, an end). */
export const ALERT_STATE_RULES = ['aimed_guessing', 'spike', 'record_trouble'] as const;
export type AlertStateRule = (typeof ALERT_STATE_RULES)[number];

/** serious_flag and alerts_held: started only. */
export const ALERT_PHASES = ['started', 'reminder', 'ended'] as const;
export type AlertPhase = (typeof ALERT_PHASES)[number];
export const ALERT_REMINDER_STEPS = ['1h', '6h', '24h'] as const;
export type AlertReminderStep = (typeof ALERT_REMINDER_STEPS)[number];
export const ALERT_OUTCOMES = ['new', 'retry', 'duplicate', 'not_sent', 'refused'] as const;
export type AlertOutcome = (typeof ALERT_OUTCOMES)[number];
export const ALERT_DISPOSITIONS = [
  'sent',
  'email_only_budget',
  'record_only',
  'held_planned_check',
  'held_for_summary',
  'held_with_notice',
  'not_sent',
] as const;
export type AlertDisposition = (typeof ALERT_DISPOSITIONS)[number];
/** Why a serious flag's email went although email alerts were off (alerts[].email_floor; null otherwise). */
export const ALERT_EMAIL_FLOORS = ['push_budget_spent', 'push_failed'] as const;
export type AlertEmailFloor = (typeof ALERT_EMAIL_FLOORS)[number];

/** What counts as a serious flag (inputs.serious, key reason|hour). */
export const SERIOUS_REASONS = [
  'passkey_counter_went_back',
  'passkey_unexplained_sign_in',
  'sign_in_not_me',
  'unrecorded_server_form_password',
  'unrecorded_server_form_code',
] as const;
/** A flood row whose outcome is flagged is a serious flag too (flagged_in_flood). 0478's list. */
export const FLOOD_REASONS = ['over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap'] as const;
export const AIMED_REASONS = [
  'repeated_wrong_password',
  'repeated_wrong_code',
  'sign_in_paused',
  'code_checks_paused',
] as const;
/** inputs.buckets[].trouble_*. */
export const TROUBLE_REASONS = ['over_minute_cap', 'over_buffer_cap'] as const;

export const ALERT_THRESHOLD_DEFAULTS = {
  aimed_guessing_events: 20,
  aimed_guessing_minutes: 30,
  record_trouble_rows: 1,
  serious_pushes_per_hour: 6,
  serious_reason_pushes_per_day: 4,
  spike_event_floor: 50,
  spike_learning_days: 14,
  spike_source_floor: 10,
  subject_pushes_per_day: 4,
  volume_pushes_per_day: 8,
} as const;
export type AlertThresholdName = keyof typeof ALERT_THRESHOLD_DEFAULTS;
export type AlertThresholds = Record<AlertThresholdName, number>;
/** The ten names, in the database's order. */
export const ALERT_THRESHOLD_NAMES = Object.keys(ALERT_THRESHOLD_DEFAULTS) as AlertThresholdName[];
/** [least, most], whole numbers; aimed_guessing_minutes in tens. */
export const ALERT_THRESHOLD_RANGES: Readonly<
  Record<AlertThresholdName, readonly [number, number]>
> = {
  aimed_guessing_events: [5, 100000],
  aimed_guessing_minutes: [10, 120],
  record_trouble_rows: [1, 100000],
  serious_pushes_per_hour: [1, 60],
  serious_reason_pushes_per_day: [1, 24],
  spike_event_floor: [10, 1000000],
  spike_learning_days: [1, 90],
  spike_source_floor: [2, 100000],
  subject_pushes_per_day: [1, 24],
  volume_pushes_per_day: [0, 100],
};
/** All false after the migration. */
export const ALERT_SWITCHES = ['email_on', 'push_on', 'summary_on'] as const;
export type AlertSwitch = (typeof ALERT_SWITCHES)[number];
export const PLANNED_CHECK_MOST_MINUTES = 30;
/** Every name a change row can carry: the switches, the planned check, the ten thresholds. */
export const ALERT_CHANGE_NAMES = [
  ...ALERT_SWITCHES,
  'planned_check',
  ...ALERT_THRESHOLD_NAMES,
] as const;
export type AlertChangeName = (typeof ALERT_CHANGE_NAMES)[number];

/** Buckets on the UTC clock: date_bin from 2000-01-01T00:00Z. */
export const ALERT_BUCKET_SECONDS = 600;
/** What inputs reads, and how old a start or serious key may be. */
export const ALERT_WINDOW_HOURS = 8;
/** A claim with no result is handed out once more. */
export const ALERT_RETRY_AFTER_MINUTES = 5;
/** An untaken retry is marked not_sent by the heartbeat. */
export const ALERT_ABANDON_AFTER_MINUTES = 30;
/** A serious flag's: the 8 hours read and a margin. */
export const ALERT_SERIOUS_ABANDON_AFTER_HOURS = 10;
export const ALERT_REPORT_AFTER_FAILURES = 3;
/** report_now at most once in 6 hours. */
export const ALERT_REPORT_GAP_HOURS = 6;
/** Volume alerts' emails a day; then held (for the summary, or with a notice). */
export const ALERT_VOLUME_EMAILS_PER_DAY = 24;
/** Record trouble's emails a day, its own. */
export const ALERT_RECORD_EMAILS_PER_DAY = 6;
/** At most one alerts_held notice in 6 hours. */
export const ALERT_HELD_NOTICE_GAP_HOURS = 6;
/** None while one is on or within 30 minutes of the last one's end. */
export const PLANNED_CHECK_GAP_MINUTES = 30;
export const PLANNED_CHECKS_PER_DAY = 4;
export const ALERT_LIST_DEFAULT = 50;
export const ALERT_LIST_MOST = 200;
export const ADMIN_EMAILS_MOST = 20;

export const PUSH_RESULT_CODES = [
  'sent',
  'failed',
  'timeout',
  'no_account',
  'no_phone',
  'skipped',
] as const;
export type PushResultCode = (typeof PUSH_RESULT_CODES)[number];
/** Each a count 0..100. */
export const EMAIL_RESULT_CODES = ['sent', 'failed', 'timeout', 'skipped'] as const;
export type EmailResultCode = (typeof EMAIL_RESULT_CODES)[number];
export const ALERT_RESULT_MOST = 100;

/** The refusal words of each function (CONTRACT.md): every refusal is an answer, never an exception. */
export const ALERT_INPUTS_REFUSALS = ['no_state', 'too_many_events_in_one_minute'] as const;
export const ALERT_CLAIM_REFUSALS = [
  'not_a_rule',
  'not_a_phase',
  'not_a_subject',
  'not_a_key',
  'not_claimable',
  'key_out_of_window',
  'not_counts',
  'no_state',
  'already_open',
  'state_ended',
  'no_open_state',
  'reminder_not_due',
] as const;
export type AlertClaimRefusal = (typeof ALERT_CLAIM_REFUSALS)[number];
export const ALERT_RESULT_REFUSALS = [
  'not_an_alert',
  'not_a_result',
  'not_sent_already',
  'nothing_to_record',
  'already_recorded',
  'not_this_attempt',
  'email_floor_due',
  'not_its_channels',
] as const;
export type AlertResultRefusal = (typeof ALERT_RESULT_REFUSALS)[number];
export const ALERT_HEARTBEAT_REFUSALS = [
  'not_a_step',
  'not_a_finish',
  'no_state',
  'not_the_latest_run',
  'already_finished',
] as const;
export type AlertHeartbeatRefusal = (typeof ALERT_HEARTBEAT_REFUSALS)[number];
export const ALERT_BASELINE_REFUSALS = [
  'no_state',
  'computed_recently',
  'too_many_events_in_one_bucket',
] as const;
export type AlertBaselineRefusal = (typeof ALERT_BASELINE_REFUSALS)[number];
/** The claim's answer: always these nine keys. */
export const ALERT_CLAIM_KEYS = [
  'outcome',
  'refused',
  'id',
  'disposition',
  'push',
  'email',
  'attempt',
  'open_key',
  'notice',
] as const;
/**
 * The claim refusals that come from the state of the alerts (another run, a
 * state that ended, a key at the window's edge, a reminder not yet due).
 * Every other refusal means this build sent an argument the database will
 * not take: a bug, reported.
 */
export const ALERT_EXPECTED_CLAIM_REFUSALS: readonly AlertClaimRefusal[] = [
  'key_out_of_window',
  'already_open',
  'state_ended',
  'no_open_state',
  'reminder_not_due',
];

/* ─────────────────────────── this module's own rules ─────────────────────────── */

const BUCKET_MS = ALERT_BUCKET_SECONDS * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A state ends only after its condition has been quiet in this many whole
 * buckets in a row (30 minutes): a scan that pauses for a few minutes stays
 * one state, so it never makes a new start (a new alert that could push)
 * each time it comes back.
 */
export const ALERT_END_QUIET_BUCKETS = 3;
/**
 * THE LOOK-BACK: every run judges the volume and record rules over its last
 * this many whole buckets, oldest first, not over the latest one alone. A
 * bucket is the latest of exactly one run; when that run fails, is missed,
 * is cut before its claims, or has its read cancelled (likely in the very
 * flood a rule is for), the next run still judges that bucket, and claims
 * its start with the key the lost run would have used (the oldest bucket of
 * the look-back where the condition holds), so the database's one row
 * answers any repeat. It equals an end's quiet period: never longer, so a
 * state that ended is never started again from the buckets that ended it.
 */
export const ALERT_LOOK_BACK_BUCKETS = ALERT_END_QUIET_BUCKETS;
/** A reminder is due when its key's time and step have passed, give or take the database's minute. */
export const ALERT_REMINDER_SLACK_MS = MINUTE_MS;
const REMINDER_STEP_MS: Readonly<Record<AlertReminderStep, number>> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': DAY_MS,
};
/** The job runs every 10 minutes (vercel.json). */
export const ALERT_JOB_EVERY_MINUTES = 10;
/** The console says checks are being missed when the latest one started longer ago than this. */
export const ALERT_MISSED_AFTER_MINUTES = 25;
/** A check that started this long ago and never finished is not "running" any more. */
export const ALERT_RUN_LONGEST_MINUTES = 2;

/* ─────────────────────────────── small readers ─────────────────────────────── */

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):([0-5]0)Z$/;
const REMINDER_KEY_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:[0-5]0Z)\+(1h|6h|24h)$/;
const SERIOUS_KEY_RE = /^([a-z][a-z0-9_]{0,47})\|(\d{4})-(\d{2})-(\d{2})T(\d{2}):00Z$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
/** At most 13 digits, as the claim takes a number in counts. */
const COUNT_MOST = 9_999_999_999_999;

/** A shape the reader does not take, with where. */
class Shape extends Error {
  constructor(readonly where: string) {
    super(where);
  }
}
function need(ok: boolean, where: string): asserts ok {
  if (!ok) throw new Shape(where);
}
const hasKey = (bag: Bag, k: string) => Object.prototype.hasOwnProperty.call(bag, k);
/**
 * An object with every key this build reads. A key it does not know is
 * IGNORED (a later migration may add one: the database goes first in every
 * release, and an unknown key must not blind the job between that migration
 * and the web deploy); each key it reads is still required, and each is then
 * checked for its type by the reader. What the readers answer holds only the
 * keys they read, so an unknown key never travels further.
 */
function bagOf(v: unknown, keys: readonly string[], where: string): Bag {
  need(isBag(v), where);
  for (const k of keys) need(hasKey(v, k), `${where}.${k}`);
  return v;
}
function countOf(v: unknown, where: string): number {
  need(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0, where);
  return v;
}
function boolOf(v: unknown, where: string): boolean {
  need(typeof v === 'boolean', where);
  return v;
}
function timeOf(v: unknown, where: string): string {
  need(typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)), where);
  return v;
}
function timeOrNull(v: unknown, where: string): string | null {
  return v === null ? null : timeOf(v, where);
}
function listOf(v: unknown, most: number, where: string): unknown[] {
  need(Array.isArray(v) && v.length <= most, where);
  return v;
}
function oneOf<T extends string>(v: unknown, list: readonly T[], where: string): T {
  need(typeof v === 'string' && (list as readonly string[]).includes(v), where);
  return v as T;
}
function uuidOf(v: unknown, where: string): string {
  need(typeof v === 'string' && UUID_RE.test(v), where);
  return v.toLowerCase();
}
const isWord = (v: unknown): v is string =>
  typeof v === 'string' && SECURITY_EVENT_REASON_RE.test(v);

/* ─────────────────────────────────── keys ─────────────────────────────────── */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** A 10-minute bucket's key on the UTC clock: `2026-11-24T10:20Z`. Null for a time not on a bucket. */
export function alertBucketKey(ms: number): string | null {
  if (!Number.isFinite(ms) || ms % BUCKET_MS !== 0) return null;
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}Z`;
}

/** The time of a bucket key (`2026-11-24T10:20Z`), or null when it is not one spelling of one bucket. */
export function alertBucketKeyMs(key: unknown): number | null {
  if (typeof key !== 'string') return null;
  const m = BUCKET_KEY_RE.exec(key);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return alertBucketKey(ms) === key ? ms : null;
}

/** A serious flag's key: `<reason>|YYYY-MM-DDTHH:00Z`. */
export function alertSeriousKey(reason: string, hourMs: number): string | null {
  if (!isWord(reason) || !Number.isFinite(hourMs) || hourMs % HOUR_MS !== 0) return null;
  return `${reason}|${alertBucketKey(hourMs)!.slice(0, 13)}:00Z`;
}

/** A serious key read back: its reason and its hour, or null. */
export function parseAlertSeriousKey(key: unknown): { reason: string; hourMs: number } | null {
  if (typeof key !== 'string') return null;
  const m = SERIOUS_KEY_RE.exec(key);
  if (!m) return null;
  const hourMs = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]));
  return alertSeriousKey(m[1]!, hourMs) === key ? { reason: m[1]!, hourMs } : null;
}

/** A reminder's key: the state's key and its step (`2026-11-24T10:20Z+6h`). */
export function alertReminderKey(stateKey: string, step: AlertReminderStep): string {
  return `${stateKey}+${step}`;
}

/** A reminder key read back, or null. */
export function parseAlertReminderKey(
  key: unknown,
): { stateKey: string; stateMs: number; step: AlertReminderStep } | null {
  if (typeof key !== 'string') return null;
  const m = REMINDER_KEY_RE.exec(key);
  if (!m) return null;
  const stateMs = alertBucketKeyMs(m[1]);
  return stateMs === null ? null : { stateKey: m[1]!, stateMs, step: m[2] as AlertReminderStep };
}

/** Whether `key` is a key the claim takes for this rule and phase (the database's own spelling rules). */
export function isAlertKeyFor(rule: AlertRule, phase: AlertPhase, key: unknown): key is string {
  if (rule === 'serious_flag') {
    const parsed = parseAlertSeriousKey(key);
    return (
      phase === 'started' &&
      parsed !== null &&
      ((SERIOUS_REASONS as readonly string[]).includes(parsed.reason) ||
        (FLOOD_REASONS as readonly string[]).includes(parsed.reason))
    );
  }
  if (rule === 'alerts_held') return phase === 'started' && alertBucketKeyMs(key) !== null;
  if (phase === 'reminder') return parseAlertReminderKey(key) !== null;
  return alertBucketKeyMs(key) !== null;
}

/* ──────────────────────────────── counts ──────────────────────────────── */

/** A value the claim takes in counts. */
export type AlertCountValue =
  number | boolean | string | ReadonlyArray<number | string> | Readonly<Record<string, number>>;
export type AlertCounts = Readonly<Record<string, AlertCountValue>>;

const isCountNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNT_MOST;

/**
 * Whether `counts` is what the claim takes: an object of at most 40 keys and
 * 4,000 characters; each key a reason-code word; each value a whole number of
 * at most 13 digits, a boolean, a word, a list of at most 50 numbers or
 * words, or an object of at most 50 words or country codes to whole numbers.
 * Never an address, an id, a path or a sample.
 */
export function isAlertCounts(counts: unknown): counts is AlertCounts {
  if (!isBag(counts)) return false;
  const keys = Object.keys(counts);
  if (keys.length > 40) return false;
  let text: string;
  try {
    text = JSON.stringify(counts);
  } catch {
    return false;
  }
  if (new TextEncoder().encode(text).length > 4000) return false;
  return keys.every((k) => {
    if (!isWord(k)) return false;
    const v = counts[k];
    if (isCountNumber(v) || typeof v === 'boolean' || isWord(v)) return true;
    if (Array.isArray(v)) return v.length <= 50 && v.every((x) => isCountNumber(x) || isWord(x));
    if (isBag(v)) {
      const inner = Object.keys(v);
      return (
        inner.length <= 50 &&
        inner.every((ik) => (isWord(ik) || COUNTRY_RE.test(ik)) && isCountNumber(v[ik]))
      );
    }
    return false;
  });
}

/* ─────────────────────────────── the inputs ─────────────────────────────── */

export interface AlertSeriousEntry {
  reason: string;
  hour: string;
  eventKey: string;
  flaggedInFlood: boolean;
  events: number;
  atLeast: boolean;
  tally: boolean;
  firstMinute: string;
  lastMinute: string;
}
export interface AlertAimedBucket {
  startMs: number;
  key: string;
  events: number;
}
export interface AlertAimedOrganization {
  organizationId: string;
  events: number;
  buckets: AlertAimedBucket[];
}
export interface AlertBucket {
  startMs: number;
  key: string;
  partial: boolean;
  events: number;
  sources: number;
  troubleRows: number;
  troubleEvents: number;
}
export interface AlertOpenState {
  rule: AlertStateRule;
  subject: string;
  eventKey: string;
  startedClaimedAt: string;
  held: boolean;
  reminders: AlertReminderStep[];
}
export interface AlertRetryDue {
  rule: AlertRule;
  subject: string;
  eventKey: string;
  phase: AlertPhase;
  claimedAt: string;
}
export interface AlertBaselineMarks {
  eventHigh: number | null;
  sourceHigh: number | null;
  eventMark: number;
  sourceMark: number;
  from: string | null;
  to: string | null;
  shortened: boolean | null;
  computedAt: string | null;
}
export interface SecurityAlertInputs {
  window: { from: string; to: string; askedFrom: string };
  shortened: boolean;
  generatedAt: string;
  /** The database's now: due-ness and ages are judged against it, never against this machine's clock. */
  nowMs: number;
  oldestEventAt: string | null;
  serious: AlertSeriousEntry[];
  aimed: AlertAimedOrganization[];
  aimedTruncated: boolean;
  buckets: AlertBucket[];
  openStates: AlertOpenState[];
  openStatesTruncated: boolean;
  seriousRetryDue: AlertRetryDue[];
  seriousRetryDueTruncated: boolean;
  retryDue: AlertRetryDue[];
  retryDueTruncated: boolean;
  thresholds: AlertThresholds;
  switches: Record<AlertSwitch, boolean>;
  plannedCheckUntil: string | null;
  baseline: AlertBaselineMarks;
}

export type AlertReadResult<T, R extends string> =
  | { ok: true; value: T; refused: null }
  | { ok: true; value: null; refused: R }
  | { ok: false; where: string };

const INPUTS_KEYS = [
  'serious',
  'aimed',
  'aimed_truncated',
  'buckets',
  'open_states',
  'open_states_truncated',
  'serious_retry_due',
  'serious_retry_due_truncated',
  'retry_due',
  'retry_due_truncated',
  'window',
  'shortened',
  'refused',
  'generated_at',
  'bucket_seconds',
  'oldest_event_at',
  'thresholds',
  'baseline',
  'switches',
  'planned_check_until',
];

function thresholdsOf(v: unknown, where: string): AlertThresholds {
  const bag = bagOf(v, ALERT_THRESHOLD_NAMES, where);
  const out = {} as AlertThresholds;
  for (const name of ALERT_THRESHOLD_NAMES) {
    const n = countOf(bag[name], `${where}.${name}`);
    need(n <= 1_000_000, `${where}.${name}`);
    out[name] = n;
  }
  return out;
}

/** A bucket's start as the database writes it, checked against its key. */
function bucketStartOf(start: unknown, key: unknown, where: string): number {
  const ms = alertBucketKeyMs(key);
  need(ms !== null, `${where}.bucket_key`);
  need(Date.parse(timeOf(start, `${where}.bucket_start`)) === ms, `${where}.bucket_start`);
  return ms;
}

function retryOf(v: unknown, serious: boolean, where: string): AlertRetryDue {
  const bag = bagOf(v, ['rule', 'subject', 'event_key', 'phase', 'claimed_at'], where);
  const rule = oneOf(bag.rule, ALERT_RULE_NAMES, `${where}.rule`);
  need((rule === 'serious_flag') === serious, `${where}.rule`);
  const phase = oneOf(bag.phase, ALERT_PHASES, `${where}.phase`);
  const subject = rule === 'aimed_guessing' ? uuidOf(bag.subject, `${where}.subject`) : bag.subject;
  need(rule === 'aimed_guessing' || subject === '', `${where}.subject`);
  need(isAlertKeyFor(rule, phase, bag.event_key), `${where}.event_key`);
  return {
    rule,
    subject: subject as string,
    eventKey: bag.event_key as string,
    phase,
    claimedAt: timeOf(bag.claimed_at, `${where}.claimed_at`),
  };
}

function readInputs(
  raw: unknown,
): AlertReadResult<SecurityAlertInputs, (typeof ALERT_INPUTS_REFUSALS)[number]> {
  need(isBag(raw), 'answer');
  if (raw.window === null) {
    const bag = bagOf(raw, ['window', 'refused', 'generated_at'], 'refused answer');
    timeOf(bag.generated_at, 'generated_at');
    return {
      ok: true,
      value: null,
      refused: oneOf(bag.refused, ALERT_INPUTS_REFUSALS, 'refused'),
    };
  }
  const bag = bagOf(raw, INPUTS_KEYS, 'answer');
  need(bag.refused === null, 'refused');
  need(bag.bucket_seconds === ALERT_BUCKET_SECONDS, 'bucket_seconds');
  const generatedAt = timeOf(bag.generated_at, 'generated_at');
  const w = bagOf(bag.window, ['from', 'to', 'asked_from'], 'window');
  const window = {
    from: timeOf(w.from, 'window.from'),
    to: timeOf(w.to, 'window.to'),
    askedFrom: timeOf(w.asked_from, 'window.asked_from'),
  };
  const shortened = boolOf(bag.shortened, 'shortened');
  need(shortened === Date.parse(window.from) > Date.parse(window.askedFrom), 'shortened');

  const serious = listOf(bag.serious, 10_000, 'serious').map((v, i) => {
    const where = `serious[${i}]`;
    const e = bagOf(
      v,
      [
        'reason',
        'hour',
        'event_key',
        'flagged_in_flood',
        'events',
        'at_least',
        'tally',
        'first_minute',
        'last_minute',
      ],
      where,
    );
    const flaggedInFlood = boolOf(e.flagged_in_flood, `${where}.flagged_in_flood`);
    const reason = oneOf(
      e.reason,
      flaggedInFlood ? FLOOD_REASONS : SERIOUS_REASONS,
      `${where}.reason`,
    );
    const hour = timeOf(e.hour, `${where}.hour`);
    need(e.event_key === alertSeriousKey(reason, Date.parse(hour)), `${where}.event_key`);
    return {
      reason,
      hour,
      eventKey: e.event_key as string,
      flaggedInFlood,
      events: countOf(e.events, `${where}.events`),
      atLeast: boolOf(e.at_least, `${where}.at_least`),
      tally: boolOf(e.tally, `${where}.tally`),
      firstMinute: timeOf(e.first_minute, `${where}.first_minute`),
      lastMinute: timeOf(e.last_minute, `${where}.last_minute`),
    };
  });

  const aimed = listOf(bag.aimed, 100, 'aimed').map((v, i) => {
    const where = `aimed[${i}]`;
    const o = bagOf(v, ['organization_id', 'events', 'buckets'], where);
    return {
      organizationId: uuidOf(o.organization_id, `${where}.organization_id`),
      events: countOf(o.events, `${where}.events`),
      buckets: listOf(o.buckets, 10_000, `${where}.buckets`).map((b, j) => {
        const cell = bagOf(b, ['bucket_start', 'bucket_key', 'events'], `${where}.buckets[${j}]`);
        return {
          startMs: bucketStartOf(cell.bucket_start, cell.bucket_key, `${where}.buckets[${j}]`),
          key: cell.bucket_key as string,
          events: countOf(cell.events, `${where}.buckets[${j}].events`),
        };
      }),
    };
  });

  const buckets = listOf(bag.buckets, 10_000, 'buckets').map((v, i) => {
    const where = `buckets[${i}]`;
    const b = bagOf(
      v,
      [
        'bucket_start',
        'bucket_key',
        'partial',
        'events',
        'sources',
        'trouble_rows',
        'trouble_events',
      ],
      where,
    );
    return {
      startMs: bucketStartOf(b.bucket_start, b.bucket_key, where),
      key: b.bucket_key as string,
      partial: boolOf(b.partial, `${where}.partial`),
      events: countOf(b.events, `${where}.events`),
      sources: countOf(b.sources, `${where}.sources`),
      troubleRows: countOf(b.trouble_rows, `${where}.trouble_rows`),
      troubleEvents: countOf(b.trouble_events, `${where}.trouble_events`),
    };
  });
  buckets.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < buckets.length; i += 1) {
    need(buckets[i]!.startMs !== buckets[i - 1]!.startMs, 'buckets (a bucket twice)');
  }

  const openStates = listOf(bag.open_states, 500, 'open_states').map((v, i) => {
    const where = `open_states[${i}]`;
    const s = bagOf(
      v,
      ['rule', 'subject', 'event_key', 'started_claimed_at', 'held', 'reminders'],
      where,
    );
    const rule = oneOf(s.rule, ALERT_STATE_RULES, `${where}.rule`);
    const subject = rule === 'aimed_guessing' ? uuidOf(s.subject, `${where}.subject`) : s.subject;
    need(rule === 'aimed_guessing' || subject === '', `${where}.subject`);
    need(alertBucketKeyMs(s.event_key) !== null, `${where}.event_key`);
    return {
      rule,
      subject: subject as string,
      eventKey: s.event_key as string,
      startedClaimedAt: timeOf(s.started_claimed_at, `${where}.started_claimed_at`),
      held: boolOf(s.held, `${where}.held`),
      reminders: listOf(s.reminders, 3, `${where}.reminders`).map((r, j) =>
        oneOf(r, ALERT_REMINDER_STEPS, `${where}.reminders[${j}]`),
      ),
    };
  });

  const sw = bagOf(bag.switches, ALERT_SWITCHES, 'switches');
  const bl = bagOf(
    bag.baseline,
    [
      'event_high',
      'source_high',
      'event_mark',
      'source_mark',
      'from',
      'to',
      'shortened',
      'computed_at',
    ],
    'baseline',
  );
  const nullableCount = (v: unknown, where: string) => (v === null ? null : countOf(v, where));
  const baseline: AlertBaselineMarks = {
    eventHigh: nullableCount(bl.event_high, 'baseline.event_high'),
    sourceHigh: nullableCount(bl.source_high, 'baseline.source_high'),
    eventMark: countOf(bl.event_mark, 'baseline.event_mark'),
    sourceMark: countOf(bl.source_mark, 'baseline.source_mark'),
    from: timeOrNull(bl.from, 'baseline.from'),
    to: timeOrNull(bl.to, 'baseline.to'),
    shortened: bl.shortened === null ? null : boolOf(bl.shortened, 'baseline.shortened'),
    computedAt: timeOrNull(bl.computed_at, 'baseline.computed_at'),
  };

  return {
    ok: true,
    refused: null,
    value: {
      window,
      shortened,
      generatedAt,
      nowMs: Date.parse(generatedAt),
      oldestEventAt: timeOrNull(bag.oldest_event_at, 'oldest_event_at'),
      serious,
      aimed,
      aimedTruncated: boolOf(bag.aimed_truncated, 'aimed_truncated'),
      buckets,
      openStates,
      openStatesTruncated: boolOf(bag.open_states_truncated, 'open_states_truncated'),
      seriousRetryDue: listOf(bag.serious_retry_due, 100, 'serious_retry_due').map((v, i) =>
        retryOf(v, true, `serious_retry_due[${i}]`),
      ),
      seriousRetryDueTruncated: boolOf(
        bag.serious_retry_due_truncated,
        'serious_retry_due_truncated',
      ),
      retryDue: listOf(bag.retry_due, 100, 'retry_due').map((v, i) =>
        retryOf(v, false, `retry_due[${i}]`),
      ),
      retryDueTruncated: boolOf(bag.retry_due_truncated, 'retry_due_truncated'),
      thresholds: thresholdsOf(bag.thresholds, 'thresholds'),
      switches: {
        email_on: boolOf(sw.email_on, 'switches.email_on'),
        push_on: boolOf(sw.push_on, 'switches.push_on'),
        summary_on: boolOf(sw.summary_on, 'switches.summary_on'),
      },
      plannedCheckUntil: timeOrNull(bag.planned_check_until, 'planned_check_until'),
      baseline,
    },
  };
}

function guarded<T>(read: () => T): T | { ok: false; where: string } {
  try {
    return read();
  } catch (e) {
    if (e instanceof Shape) return { ok: false, where: e.where };
    return { ok: false, where: 'unreadable' };
  }
}

/** platform_security_alert_inputs(): the read, a refusal, or a shape this build does not know. */
export function readSecurityAlertInputs(
  raw: unknown,
): AlertReadResult<SecurityAlertInputs, (typeof ALERT_INPUTS_REFUSALS)[number]> {
  return guarded(() => readInputs(raw));
}

/* ─────────────────────────────── the claim ─────────────────────────────── */

export interface AlertNotice {
  id: string;
  eventKey: string;
  push: boolean;
  email: boolean;
  attempt: 1;
}
export interface AlertClaimAnswer {
  outcome: AlertOutcome;
  refused: AlertClaimRefusal | null;
  id: string | null;
  disposition: AlertDisposition | null;
  push: boolean;
  email: boolean;
  attempt: 1 | 2 | null;
  openKey: string | null;
  notice: AlertNotice | null;
}

/** platform_security_alert_claim(...): always nine keys, each checked against the outcome. */
export function readSecurityAlertClaim(
  raw: unknown,
): { ok: true; claim: AlertClaimAnswer } | { ok: false; where: string } {
  return guarded(() => {
    const bag = bagOf(raw, ALERT_CLAIM_KEYS, 'claim');
    const outcome = oneOf(bag.outcome, ALERT_OUTCOMES, 'outcome');
    const refused =
      bag.refused === null ? null : oneOf(bag.refused, ALERT_CLAIM_REFUSALS, 'refused');
    need((outcome === 'refused') === (refused !== null), 'refused');
    const id = bag.id === null ? null : uuidOf(bag.id, 'id');
    const disposition =
      bag.disposition === null ? null : oneOf(bag.disposition, ALERT_DISPOSITIONS, 'disposition');
    const push = boolOf(bag.push, 'push');
    const email = boolOf(bag.email, 'email');
    need(bag.attempt === null || bag.attempt === 1 || bag.attempt === 2, 'attempt');
    const attempt = bag.attempt as 1 | 2 | null;
    need(bag.open_key === null || typeof bag.open_key === 'string', 'open_key');
    const openKey = bag.open_key as string | null;
    if (openKey !== null) need(alertBucketKeyMs(openKey) !== null, 'open_key');
    let notice: AlertNotice | null = null;
    if (bag.notice !== null) {
      const n = bagOf(bag.notice, ['id', 'event_key', 'push', 'email', 'attempt'], 'notice');
      need(n.attempt === 1, 'notice.attempt');
      need(alertBucketKeyMs(n.event_key) !== null, 'notice.event_key');
      notice = {
        id: uuidOf(n.id, 'notice.id'),
        eventKey: n.event_key as string,
        push: boolOf(n.push, 'notice.push'),
        email: boolOf(n.email, 'notice.email'),
        attempt: 1,
      };
    }
    if (outcome === 'new' || outcome === 'retry') {
      need(id !== null && disposition !== null, 'id');
      need(attempt === (outcome === 'new' ? 1 : 2), 'attempt');
    } else {
      // Nothing is handed out for any other outcome.
      need(!push && !email, 'push');
    }
    need(notice === null || (outcome === 'new' && disposition === 'held_with_notice'), 'notice');
    return {
      ok: true as const,
      claim: { outcome, refused, id, disposition, push, email, attempt, openKey, notice },
    };
  });
}

/** platform_security_alert_result(...): {recorded, refused}. */
export function readSecurityAlertResult(
  raw: unknown,
):
  | { ok: true; recorded: boolean; refused: AlertResultRefusal | null }
  | { ok: false; where: string } {
  return guarded(() => {
    const bag = bagOf(raw, ['recorded', 'refused'], 'result');
    const recorded = boolOf(bag.recorded, 'recorded');
    const refused =
      bag.refused === null ? null : oneOf(bag.refused, ALERT_RESULT_REFUSALS, 'refused');
    need(recorded === (refused === null), 'recorded');
    return { ok: true as const, recorded, refused };
  });
}

/* ─────────────────────────────── the heartbeat ─────────────────────────────── */

export interface AlertHeartbeatStart {
  runId: string;
  previous: { startedAt: string | null; finishedAt: string | null; ok: boolean | null };
  lastOkAt: string | null;
  missedRuns: number;
  failuresInARow: number;
  reportNow: boolean;
  markedNotSent: number;
}
export interface AlertHeartbeatFinish {
  failuresInARow: number;
  reportNow: boolean;
}

function heartbeatRefusal(bag: Bag, step: 'start' | 'finish'): AlertHeartbeatRefusal | null {
  if (!hasKey(bag, 'refused') || bag.refused === null) return null;
  bagOf(bag, ['step', 'refused'], 'heartbeat');
  need(bag.step === null || bag.step === step, 'step');
  return oneOf(bag.refused, ALERT_HEARTBEAT_REFUSALS, 'refused');
}

/** heartbeat('start'). */
export function readSecurityAlertHeartbeatStart(
  raw: unknown,
): AlertReadResult<AlertHeartbeatStart, AlertHeartbeatRefusal> {
  return guarded(() => {
    need(isBag(raw), 'heartbeat');
    const refused = heartbeatRefusal(raw, 'start');
    if (refused !== null) return { ok: true as const, value: null, refused };
    const bag = bagOf(
      raw,
      [
        'step',
        'refused',
        'run_id',
        'previous',
        'last_ok_at',
        'missed_runs',
        'failures_in_a_row',
        'report_now',
        'marked_not_sent',
      ],
      'heartbeat',
    );
    need(bag.step === 'start' && bag.refused === null, 'step');
    const prev = bagOf(bag.previous, ['started_at', 'finished_at', 'ok'], 'previous');
    return {
      ok: true as const,
      refused: null,
      value: {
        runId: uuidOf(bag.run_id, 'run_id'),
        previous: {
          startedAt: timeOrNull(prev.started_at, 'previous.started_at'),
          finishedAt: timeOrNull(prev.finished_at, 'previous.finished_at'),
          ok: prev.ok === null ? null : boolOf(prev.ok, 'previous.ok'),
        },
        lastOkAt: timeOrNull(bag.last_ok_at, 'last_ok_at'),
        missedRuns: countOf(bag.missed_runs, 'missed_runs'),
        failuresInARow: countOf(bag.failures_in_a_row, 'failures_in_a_row'),
        reportNow: boolOf(bag.report_now, 'report_now'),
        markedNotSent: countOf(bag.marked_not_sent, 'marked_not_sent'),
      },
    };
  });
}

/** heartbeat('finish', ...). */
export function readSecurityAlertHeartbeatFinish(
  raw: unknown,
): AlertReadResult<AlertHeartbeatFinish, AlertHeartbeatRefusal> {
  return guarded(() => {
    need(isBag(raw), 'heartbeat');
    const refused = heartbeatRefusal(raw, 'finish');
    if (refused !== null) return { ok: true as const, value: null, refused };
    const bag = bagOf(raw, ['step', 'refused', 'failures_in_a_row', 'report_now'], 'heartbeat');
    need(bag.step === 'finish' && bag.refused === null, 'step');
    return {
      ok: true as const,
      refused: null,
      value: {
        failuresInARow: countOf(bag.failures_in_a_row, 'failures_in_a_row'),
        reportNow: boolOf(bag.report_now, 'report_now'),
      },
    };
  });
}

/* ─────────────────────────────── the baseline ─────────────────────────────── */

export interface AlertBaselineComputed {
  eventHigh: number;
  sourceHigh: number;
  from: string;
  to: string;
  askedFrom: string;
  shortened: boolean;
  buckets: number;
  computedAt: string;
}

/** platform_security_alert_baseline(). */
export function readSecurityAlertBaseline(
  raw: unknown,
): AlertReadResult<AlertBaselineComputed, AlertBaselineRefusal> {
  return guarded(() => {
    need(isBag(raw), 'baseline');
    if (raw.computed === false) {
      const refused = oneOf(raw.refused, ALERT_BASELINE_REFUSALS, 'refused');
      if (refused === 'computed_recently') {
        const bag = bagOf(raw, ['computed', 'refused', 'computed_at'], 'baseline');
        timeOf(bag.computed_at, 'computed_at');
      } else {
        bagOf(raw, ['computed', 'refused'], 'baseline');
      }
      return { ok: true as const, value: null, refused };
    }
    const bag = bagOf(
      raw,
      [
        'computed',
        'refused',
        'event_high',
        'source_high',
        'from',
        'to',
        'asked_from',
        'shortened',
        'buckets',
        'computed_at',
      ],
      'baseline',
    );
    need(bag.computed === true && bag.refused === null, 'computed');
    return {
      ok: true as const,
      refused: null,
      value: {
        eventHigh: countOf(bag.event_high, 'event_high'),
        sourceHigh: countOf(bag.source_high, 'source_high'),
        from: timeOf(bag.from, 'from'),
        to: timeOf(bag.to, 'to'),
        askedFrom: timeOf(bag.asked_from, 'asked_from'),
        shortened: boolOf(bag.shortened, 'shortened'),
        buckets: countOf(bag.buckets, 'buckets'),
        computedAt: timeOf(bag.computed_at, 'computed_at'),
      },
    };
  });
}

/* ─────────────────────────────── the rules ─────────────────────────────── */

/** What the job asks the claim, as its arguments. */
export interface AlertClaimAsk {
  rule: AlertRule;
  subject: string;
  eventKey: string;
  phase: AlertPhase;
  /** Null: none (a retry hands out what the first claim planned and stores nothing new). */
  counts: AlertCounts | null;
}

/** Why the spike rule is not judged: no baseline yet, or a record younger than the learning days. */
export type AlertSpikeHeld = 'no_baseline' | 'learning' | null;

export interface SecurityAlertPlan {
  /**
   * A partial read: the window was cut, or a list was full. The plan holds no
   * end, and the run finishes with p_partial (the console: "could not check
   * fully").
   */
  partial: boolean;
  /** When the window was cut: serious flags dated before this were not read. */
  shortenedFrom: string | null;
  spikeHeld: AlertSpikeHeld;
  /**
   * The latest whole bucket the run judged (the newest of its look-back; a
   * start refused state_ended is claimed again with it); null when the read
   * holds none.
   */
  judgedBucketKey: string | null;
  /** Step 3a, then 3b: every serious flag before anything else. */
  seriousRetries: AlertClaimAsk[];
  serious: AlertClaimAsk[];
  /** Step 4: the volume and record alerts' retries (and the held notices'). */
  retries: AlertClaimAsk[];
  /** Steps 5 and 6: a start, a reminder or an end per condition. */
  conditions: AlertClaimAsk[];
}

/** Whether a read is partial (CONTRACT.md step 6): never an end from it. */
export function isSecurityAlertReadPartial(inputs: SecurityAlertInputs): boolean {
  return (
    inputs.shortened ||
    inputs.aimedTruncated ||
    inputs.openStatesTruncated ||
    inputs.seriousRetryDueTruncated ||
    inputs.retryDueTruncated
  );
}

/**
 * The spike rule is HELD (not judged, nothing claimed) while there is no
 * baseline, or while the record's oldest event is younger than
 * spike_learning_days (with no baseline the marks are only the floors).
 */
export function securityAlertSpikeHeld(inputs: SecurityAlertInputs): AlertSpikeHeld {
  if (inputs.baseline.computedAt === null) return 'no_baseline';
  const oldest = inputs.oldestEventAt === null ? NaN : Date.parse(inputs.oldestEventAt);
  if (!Number.isFinite(oldest)) return 'learning';
  return inputs.nowMs - oldest < inputs.thresholds.spike_learning_days * DAY_MS ? 'learning' : null;
}

/** The whole buckets of the read, oldest first (a partial one, running now or cut, is never judged). */
function wholeBuckets(inputs: SecurityAlertInputs): AlertBucket[] {
  return inputs.buckets.filter((b) => !b.partial);
}

/** Guessing aimed at one organization: its events in the `minutes` of whole buckets that end with `endMs`. */
export function aimedEventsAt(org: AlertAimedOrganization, endMs: number, minutes: number): number {
  const span = Math.max(1, Math.round(minutes / 10)) * BUCKET_MS;
  return org.buckets
    .filter((b) => b.startMs <= endMs && b.startMs > endMs - span)
    .reduce((sum, b) => sum + b.events, 0);
}

/** A spike: more events than the event mark, from at least the source mark's distinct sources. */
export function isSpikeBucket(bucket: AlertBucket, baseline: AlertBaselineMarks): boolean {
  return bucket.events > baseline.eventMark && bucket.sources >= baseline.sourceMark;
}

/** Record trouble: at least record_trouble_rows flood rows of the record itself in the bucket. */
export function isTroubleBucket(bucket: AlertBucket, thresholds: AlertThresholds): boolean {
  return bucket.troubleRows >= thresholds.record_trouble_rows;
}

/** The latest step of a state that is due now and not claimed yet: never two in one run. */
export function dueReminderStep(
  stateKey: string,
  nowMs: number,
  claimed: readonly AlertReminderStep[],
): AlertReminderStep | null {
  const at = alertBucketKeyMs(stateKey);
  if (at === null) return null;
  let latest: AlertReminderStep | null = null;
  for (const step of ALERT_REMINDER_STEPS) {
    if (at + REMINDER_STEP_MS[step] <= nowMs + ALERT_REMINDER_SLACK_MS) latest = step;
  }
  if (latest === null || claimed.includes(latest)) return null;
  // A later step already claimed (it cannot be: it was not due) leaves nothing to claim.
  const later = ALERT_REMINDER_STEPS.slice(ALERT_REMINDER_STEPS.indexOf(latest) + 1);
  return later.some((s) => claimed.includes(s)) ? null : latest;
}

/**
 * The key to claim a start again with, after the claim answered state_ended
 * for `refusedKey` (the condition is back): the latest whole bucket the run
 * judged, when it is newer; else null (an overlapping run in the same
 * bucket: left to the next run). Never the refused key.
 */
export function nextStartKey(refusedKey: string, judgedBucketKey: string | null): string | null {
  const refused = alertBucketKeyMs(refusedKey);
  const judged = alertBucketKeyMs(judgedBucketKey);
  return refused !== null && judged !== null && judged > refused ? judgedBucketKey : null;
}

/** One whole bucket of the look-back: whether the condition holds there, and its counts there. */
interface Look {
  key: string;
  holds: boolean;
  counts: AlertCounts;
}

interface Condition {
  rule: AlertStateRule;
  subject: string;
  /** The look-back, oldest first (see ALERT_LOOK_BACK_BUCKETS). */
  looks: Look[];
}

/**
 * Turns the conditions into claims: for each rule and subject, a start (none
 * open, it holds in a bucket of the look-back: keyed by the OLDEST such
 * bucket, with that bucket's counts), the due reminder (open, it still holds
 * in the look-back: the newest such bucket's counts), or an end (open, quiet
 * in every bucket of a full look-back, and the read is whole).
 */
function stateClaims(
  inputs: SecurityAlertInputs,
  conditions: readonly Condition[],
  rules: readonly AlertStateRule[],
  canEnd: boolean,
): AlertClaimAsk[] {
  const out: AlertClaimAsk[] = [];
  const byKey = new Map<string, Condition>();
  for (const c of conditions) byKey.set(`${c.rule}|${c.subject}`, c);
  const open = new Map<string, AlertOpenState>();
  for (const s of inputs.openStates) {
    if (!rules.includes(s.rule)) continue;
    const k = `${s.rule}|${s.subject}`;
    const was = open.get(k);
    // One open state for a rule and subject (the database's rule); the newest if ever more.
    if (!was || Date.parse(s.startedClaimedAt) > Date.parse(was.startedClaimedAt)) open.set(k, s);
  }
  const seen = new Set<string>();
  // The conditions in their order (busiest first), then the open states no condition names.
  const order = [
    ...conditions.map((c) => `${c.rule}|${c.subject}`),
    ...[...open.keys()].filter((k) => !byKey.has(k)),
  ];
  for (const k of order) {
    if (seen.has(k)) continue;
    seen.add(k);
    const c = byKey.get(k);
    const state = open.get(k);
    const [rule, subject] = [
      k.slice(0, k.indexOf('|')) as AlertStateRule,
      k.slice(k.indexOf('|') + 1),
    ];
    const held = c ? c.looks.filter((l) => l.holds) : [];
    if (state) {
      if (held.length > 0) {
        const step = dueReminderStep(state.eventKey, inputs.nowMs, state.reminders);
        if (step !== null) {
          out.push({
            rule,
            subject,
            eventKey: alertReminderKey(state.eventKey, step),
            phase: 'reminder',
            counts: held[held.length - 1]!.counts,
          });
        }
      } else if (canEnd) {
        out.push({
          rule,
          subject,
          eventKey: state.eventKey,
          phase: 'ended',
          counts: c?.looks[c.looks.length - 1]?.counts ?? {
            quiet_minutes: ALERT_END_QUIET_BUCKETS * 10,
          },
        });
      }
    } else if (held.length > 0) {
      out.push({
        rule,
        subject,
        eventKey: held[0]!.key,
        phase: 'started',
        counts: held[0]!.counts,
      });
    }
  }
  return out;
}

/**
 * THE PLAN OF ONE RUN, from the inputs alone (CONTRACT.md steps 3 to 6):
 * serious retries, serious flags, the other retries, then each condition's
 * start, reminder or end. Keys come from the events; due-ness and ages are
 * judged against the database's own now (inputs.generated_at).
 */
export function planSecurityAlerts(inputs: SecurityAlertInputs): SecurityAlertPlan {
  const partial = isSecurityAlertReadPartial(inputs);
  const spikeHeld = securityAlertSpikeHeld(inputs);
  const whole = wholeBuckets(inputs);
  const judgedKey = whole.length > 0 ? whole[whole.length - 1]!.key : null;
  // The look-back: the last ALERT_LOOK_BACK_BUCKETS whole buckets, oldest first.
  const lookBack = whole.slice(-ALERT_LOOK_BACK_BUCKETS);
  // An end needs its whole quiet period in sight, and a whole read.
  const canEnd = !partial && lookBack.length === ALERT_END_QUIET_BUCKETS;
  const t = inputs.thresholds;

  const seriousRetries: AlertClaimAsk[] = inputs.seriousRetryDue.map((r) => ({
    rule: 'serious_flag',
    subject: '',
    eventKey: r.eventKey,
    phase: 'started',
    counts: null,
  }));
  const serious: AlertClaimAsk[] = inputs.serious.map((s) => ({
    rule: 'serious_flag',
    subject: '',
    eventKey: s.eventKey,
    phase: 'started',
    counts: {
      events: Math.min(s.events, COUNT_MOST),
      at_least: s.atLeast,
      tally: s.tally,
      flagged_in_flood: s.flaggedInFlood,
    },
  }));
  const retries: AlertClaimAsk[] = inputs.retryDue.map((r) => ({
    rule: r.rule,
    subject: r.subject,
    eventKey: r.eventKey,
    phase: r.phase,
    counts: null,
  }));

  const conditions: AlertClaimAsk[] = [];
  // Record trouble first: the record itself flooding hides everything else.
  conditions.push(
    ...stateClaims(
      inputs,
      lookBack.length > 0
        ? [
            {
              rule: 'record_trouble',
              subject: '',
              looks: lookBack.map((b) => ({
                key: b.key,
                holds: isTroubleBucket(b, t),
                counts: { rows: b.troubleRows, events: Math.min(b.troubleEvents, COUNT_MOST) },
              })),
            },
          ]
        : [],
      ['record_trouble'],
      canEnd,
    ),
  );
  if (spikeHeld === null) {
    conditions.push(
      ...stateClaims(
        inputs,
        lookBack.length > 0
          ? [
              {
                rule: 'spike',
                subject: '',
                looks: lookBack.map((b) => ({
                  key: b.key,
                  holds: isSpikeBucket(b, inputs.baseline),
                  counts: {
                    events: Math.min(b.events, COUNT_MOST),
                    sources: Math.min(b.sources, COUNT_MOST),
                    event_mark: inputs.baseline.eventMark,
                    source_mark: inputs.baseline.sourceMark,
                  },
                })),
              },
            ]
          : [],
        ['spike'],
        canEnd,
      ),
    );
  }
  {
    const aimed: Condition[] =
      lookBack.length > 0
        ? inputs.aimed.map((org) => ({
            rule: 'aimed_guessing' as const,
            subject: org.organizationId,
            looks: lookBack.map((b) => {
              const n = aimedEventsAt(org, b.startMs, t.aimed_guessing_minutes);
              return {
                key: b.key,
                holds: n >= t.aimed_guessing_events,
                counts: { events: Math.min(n, COUNT_MOST), minutes: t.aimed_guessing_minutes },
              };
            }),
          }))
        : [];
    conditions.push(...stateClaims(inputs, aimed, ['aimed_guessing'], canEnd));
  }

  return {
    partial,
    shortenedFrom: inputs.shortened ? inputs.window.from : null,
    spikeHeld,
    judgedBucketKey: judgedKey,
    seriousRetries,
    serious,
    retries,
    conditions,
  };
}

/** Every claim of a plan in the order the job makes them: serious flags first, always. */
export function securityAlertClaimOrder(plan: SecurityAlertPlan): AlertClaimAsk[] {
  return [...plan.seriousRetries, ...plan.serious, ...plan.retries, ...plan.conditions];
}

/* ─────────────────────────── record only (4a) ─────────────────────────── */

/** What release 4a records for a channel it was handed out for: nothing was sent to any of its recipients. */
export function recordOnlyResult(recipients: number): { skipped: number } {
  const n = Number.isSafeInteger(recipients) && recipients > 0 ? recipients : 0;
  return { skipped: Math.min(n, ALERT_RESULT_MOST) };
}

/* ─────────────────────────────── the console's read ─────────────────────────────── */

export type AlertPushResult = Partial<Record<PushResultCode, number>>;
export type AlertEmailResult = Partial<Record<EmailResultCode, number>>;

export interface SecurityAlertRow {
  rule: AlertRule;
  class: AlertClass;
  /** An organization id for aimed_guessing; '' otherwise. */
  subject: string;
  /** The organization's name as the read gives it (at most 200 characters), or null. */
  organizationName: string | null;
  eventKey: string;
  phase: AlertPhase;
  counts: AlertCounts;
  disposition: AlertDisposition;
  pushPlanned: boolean;
  emailPlanned: boolean;
  pushCounted: boolean;
  emailFloor: AlertEmailFloor | null;
  pushResult: AlertPushResult | null;
  emailResult: AlertEmailResult | null;
  attempts: 1 | 2;
  claimedAt: string;
  resultedAt: string | null;
  stateEndedAt: string | null;
  awaitingResult: boolean;
  overdue: boolean;
}

export type AlertChangeValue = boolean | number | string | null;
export interface SecurityAlertChange {
  changedAt: string;
  actorUserId: string;
  name: AlertChangeName;
  oldValue: AlertChangeValue;
  newValue: AlertChangeValue;
}

export interface SecurityAlertHeartbeat {
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunOk: boolean | null;
  lastRunPartial: boolean | null;
  lastOkAt: string | null;
  failuresInARow: number;
  failureReportedAt: string | null;
}

export interface SecurityAlertList {
  generatedAt: string;
  state: {
    emailOn: boolean;
    pushOn: boolean;
    summaryOn: boolean;
    recordOnly: boolean;
    plannedCheckUntil: string | null;
    thresholds: AlertThresholds;
    baseline: {
      eventHigh: number | null;
      sourceHigh: number | null;
      from: string | null;
      to: string | null;
      shortened: boolean | null;
      computedAt: string | null;
    };
    heartbeat: SecurityAlertHeartbeat;
  };
  budget: {
    seriousPushesLastHour: number;
    seriousPushesLastDayByReason: Record<string, number>;
    volumePushesLastDay: number;
    volumeEmailsLastDay: number;
    recordEmailsLastDay: number;
  };
  alerts: SecurityAlertRow[];
  alertsTruncated: boolean;
  changes: SecurityAlertChange[];
  changesTruncated: boolean;
  latestChanges: SecurityAlertChange[];
}

function resultOf<C extends string>(
  v: unknown,
  codes: readonly C[],
  where: string,
): Partial<Record<C, number>> | null {
  if (v === null) return null;
  need(isBag(v) && Object.keys(v).length > 0, where);
  const out: Partial<Record<C, number>> = {};
  for (const [k, n] of Object.entries(v)) {
    const code = oneOf(k, codes, `${where}.${k}`);
    const c = countOf(n, `${where}.${k}`);
    need(c <= ALERT_RESULT_MOST, `${where}.${k}`);
    out[code] = c;
  }
  return out;
}

function changeValueOf(name: AlertChangeName, v: unknown, where: string): AlertChangeValue {
  if ((ALERT_SWITCHES as readonly string[]).includes(name)) return boolOf(v, where);
  if (name === 'planned_check') return timeOrNull(v, where);
  return countOf(v, where);
}

function changeOf(v: unknown, where: string): SecurityAlertChange {
  const c = bagOf(v, ['changed_at', 'actor_user_id', 'name', 'old_value', 'new_value'], where);
  const name = oneOf(c.name, ALERT_CHANGE_NAMES, `${where}.name`);
  return {
    changedAt: timeOf(c.changed_at, `${where}.changed_at`),
    actorUserId: uuidOf(c.actor_user_id, `${where}.actor_user_id`),
    name,
    oldValue: changeValueOf(name, c.old_value, `${where}.old_value`),
    newValue: changeValueOf(name, c.new_value, `${where}.new_value`),
  };
}

function alertRowOf(v: unknown, where: string): SecurityAlertRow {
  const a = bagOf(
    v,
    [
      'rule',
      'class',
      'subject',
      'organization_name',
      'event_key',
      'phase',
      'counts',
      'disposition',
      'push_planned',
      'email_planned',
      'push_counted',
      'email_floor',
      'push_result',
      'email_result',
      'attempts',
      'claimed_at',
      'resulted_at',
      'state_ended_at',
      'awaiting_result',
      'overdue',
    ],
    where,
  );
  const rule = oneOf(a.rule, ALERT_RULE_NAMES, `${where}.rule`);
  need(a.class === ALERT_RULES[rule], `${where}.class`);
  const phase = oneOf(a.phase, ALERT_PHASES, `${where}.phase`);
  const subject = rule === 'aimed_guessing' ? uuidOf(a.subject, `${where}.subject`) : a.subject;
  need(rule === 'aimed_guessing' || subject === '', `${where}.subject`);
  need(isAlertKeyFor(rule, phase, a.event_key), `${where}.event_key`);
  need(
    a.organization_name === null ||
      (typeof a.organization_name === 'string' && [...a.organization_name].length <= 200),
    `${where}.organization_name`,
  );
  need(isAlertCounts(a.counts), `${where}.counts`);
  need(a.attempts === 1 || a.attempts === 2, `${where}.attempts`);
  return {
    rule,
    class: ALERT_RULES[rule],
    subject: subject as string,
    organizationName: rule === 'aimed_guessing' ? (a.organization_name as string | null) : null,
    eventKey: a.event_key as string,
    phase,
    counts: a.counts as AlertCounts,
    disposition: oneOf(a.disposition, ALERT_DISPOSITIONS, `${where}.disposition`),
    pushPlanned: boolOf(a.push_planned, `${where}.push_planned`),
    emailPlanned: boolOf(a.email_planned, `${where}.email_planned`),
    pushCounted: boolOf(a.push_counted, `${where}.push_counted`),
    emailFloor:
      a.email_floor === null
        ? null
        : oneOf(a.email_floor, ALERT_EMAIL_FLOORS, `${where}.email_floor`),
    pushResult: resultOf(a.push_result, PUSH_RESULT_CODES, `${where}.push_result`),
    emailResult: resultOf(a.email_result, EMAIL_RESULT_CODES, `${where}.email_result`),
    attempts: a.attempts as 1 | 2,
    claimedAt: timeOf(a.claimed_at, `${where}.claimed_at`),
    resultedAt: timeOrNull(a.resulted_at, `${where}.resulted_at`),
    stateEndedAt: timeOrNull(a.state_ended_at, `${where}.state_ended_at`),
    awaitingResult: boolOf(a.awaiting_result, `${where}.awaiting_result`),
    overdue: boolOf(a.overdue, `${where}.overdue`),
  };
}

/** platform_security_alert_list(...): the console's read, a refusal, or a shape this build does not know. */
export function readSecurityAlertList(
  raw: unknown,
): AlertReadResult<SecurityAlertList, 'no_state'> {
  return guarded(() => {
    need(isBag(raw), 'list');
    if (raw.refused !== null) {
      const bag = bagOf(raw, ['refused', 'generated_at'], 'list');
      timeOf(bag.generated_at, 'generated_at');
      return {
        ok: true as const,
        value: null,
        refused: oneOf(bag.refused, ['no_state'] as const, 'refused'),
      };
    }
    const bag = bagOf(
      raw,
      [
        'refused',
        'generated_at',
        'state',
        'budget',
        'alerts',
        'alerts_truncated',
        'changes',
        'changes_truncated',
        'latest_changes',
      ],
      'list',
    );
    const s = bagOf(
      bag.state,
      [
        'email_on',
        'push_on',
        'summary_on',
        'record_only',
        'planned_check_until',
        'thresholds',
        'baseline',
        'heartbeat',
      ],
      'state',
    );
    const bl = bagOf(
      s.baseline,
      ['event_high', 'source_high', 'from', 'to', 'shortened', 'computed_at'],
      'state.baseline',
    );
    const hb = bagOf(
      s.heartbeat,
      [
        'last_run_started_at',
        'last_run_finished_at',
        'last_run_ok',
        'last_run_partial',
        'last_ok_at',
        'failures_in_a_row',
        'failure_reported_at',
      ],
      'state.heartbeat',
    );
    const b = bagOf(
      bag.budget,
      [
        'serious_pushes_last_hour',
        'serious_pushes_last_day_by_reason',
        'volume_pushes_last_day',
        'volume_emails_last_day',
        'record_emails_last_day',
      ],
      'budget',
    );
    need(isBag(b.serious_pushes_last_day_by_reason), 'budget.serious_pushes_last_day_by_reason');
    const byReason: Record<string, number> = {};
    for (const [reason, n] of Object.entries(b.serious_pushes_last_day_by_reason)) {
      need(isWord(reason), 'budget.serious_pushes_last_day_by_reason');
      byReason[reason] = countOf(n, 'budget.serious_pushes_last_day_by_reason');
    }
    const emailOn = boolOf(s.email_on, 'state.email_on');
    const pushOn = boolOf(s.push_on, 'state.push_on');
    const recordOnly = boolOf(s.record_only, 'state.record_only');
    need(recordOnly === (!emailOn && !pushOn), 'state.record_only');
    const nullableCount = (v: unknown, where: string) => (v === null ? null : countOf(v, where));
    const nullableBool = (v: unknown, where: string) => (v === null ? null : boolOf(v, where));
    return {
      ok: true as const,
      refused: null,
      value: {
        generatedAt: timeOf(bag.generated_at, 'generated_at'),
        state: {
          emailOn,
          pushOn,
          summaryOn: boolOf(s.summary_on, 'state.summary_on'),
          recordOnly,
          plannedCheckUntil: timeOrNull(s.planned_check_until, 'state.planned_check_until'),
          thresholds: thresholdsOf(s.thresholds, 'state.thresholds'),
          baseline: {
            eventHigh: nullableCount(bl.event_high, 'state.baseline.event_high'),
            sourceHigh: nullableCount(bl.source_high, 'state.baseline.source_high'),
            from: timeOrNull(bl.from, 'state.baseline.from'),
            to: timeOrNull(bl.to, 'state.baseline.to'),
            shortened: nullableBool(bl.shortened, 'state.baseline.shortened'),
            computedAt: timeOrNull(bl.computed_at, 'state.baseline.computed_at'),
          },
          heartbeat: {
            lastRunStartedAt: timeOrNull(hb.last_run_started_at, 'heartbeat.last_run_started_at'),
            lastRunFinishedAt: timeOrNull(
              hb.last_run_finished_at,
              'heartbeat.last_run_finished_at',
            ),
            lastRunOk: nullableBool(hb.last_run_ok, 'heartbeat.last_run_ok'),
            lastRunPartial: nullableBool(hb.last_run_partial, 'heartbeat.last_run_partial'),
            lastOkAt: timeOrNull(hb.last_ok_at, 'heartbeat.last_ok_at'),
            failuresInARow: countOf(hb.failures_in_a_row, 'heartbeat.failures_in_a_row'),
            failureReportedAt: timeOrNull(hb.failure_reported_at, 'heartbeat.failure_reported_at'),
          },
        },
        budget: {
          seriousPushesLastHour: countOf(
            b.serious_pushes_last_hour,
            'budget.serious_pushes_last_hour',
          ),
          seriousPushesLastDayByReason: byReason,
          volumePushesLastDay: countOf(b.volume_pushes_last_day, 'budget.volume_pushes_last_day'),
          volumeEmailsLastDay: countOf(b.volume_emails_last_day, 'budget.volume_emails_last_day'),
          recordEmailsLastDay: countOf(b.record_emails_last_day, 'budget.record_emails_last_day'),
        },
        alerts: listOf(bag.alerts, ALERT_LIST_MOST, 'alerts').map((v, i) =>
          alertRowOf(v, `alerts[${i}]`),
        ),
        alertsTruncated: boolOf(bag.alerts_truncated, 'alerts_truncated'),
        changes: listOf(bag.changes, ALERT_LIST_MOST, 'changes').map((v, i) =>
          changeOf(v, `changes[${i}]`),
        ),
        changesTruncated: boolOf(bag.changes_truncated, 'changes_truncated'),
        latestChanges: listOf(bag.latest_changes, ALERT_CHANGE_NAMES.length, 'latest_changes').map(
          (v, i) => changeOf(v, `latest_changes[${i}]`),
        ),
      },
    };
  });
}

/* ─────────────────────────── what leaves the server ─────────────────────────── */

/** One change as the page shows it: the actor's sign-in email when the server could find it. */
export interface SecurityAlertChangeView extends SecurityAlertChange {
  actorEmail: string | null;
}

/** THE PAGE'S VIEW: the read, with each change's actor resolved on the server. */
export interface SecurityAlertsView extends Omit<SecurityAlertList, 'changes' | 'latestChanges'> {
  changes: SecurityAlertChangeView[];
  latestChanges: SecurityAlertChangeView[];
}

/** The one answer every caller the console's rule turns away gets. */
export const SECURITY_ALERTS_REFUSED = Object.freeze({ ok: false, reason: 'refused' } as const);
/** The read failed, timed out, was refused (no_state), or answered a shape this build does not know. */
export const SECURITY_ALERTS_FAILED = Object.freeze({
  ok: false,
  reason: 'could_not_check',
} as const);
export type SecurityAlertsResult =
  | { ok: true; view: SecurityAlertsView }
  | typeof SECURITY_ALERTS_REFUSED
  | typeof SECURITY_ALERTS_FAILED;

/* ─────────────────────────────────── words ─────────────────────────────────── */

export const SECURITY_ALERTS_WORDS = {
  title: 'Security alerts',
  subline:
    'What the alert job found when it checked the security record, every 10 minutes, and what it would send.',
  openFromSecurity: 'Open alerts',
  back: '← Security',
  loading: 'Checking the alerts...',
  refused:
    'This read was refused. Sign in to the platform console again (with your authenticator) to see the alerts.',
  couldNotCheck:
    'The alerts could not be checked just now. This does not mean there are none. Try again in a moment.',
  checkAgain: 'Check again',
  checking: 'Checking...',
  recordOnlyBanner: 'Record only: nothing is being sent yet.',
  recordOnlyNote:
    'Every alert below is recorded, and none goes out by push or email in this release. What each one would have done is worked out from the push budget alone: while every channel is off, the daily email caps and the choice to hold an alert are not worked out, so they are not shown.',
  channelOnNote:
    'A channel is on, but this release sends nothing: an alert handed out to be sent is recorded as skipped.',
  heartbeatHeading: 'The alert job',
  alertsHeading: 'Latest alerts',
  noAlerts: 'No alert has been recorded yet.',
  alertsTruncated: (n: number) => `The newest ${n} are listed. Older alerts are kept for 400 days.`,
  thresholdsHeading: 'Thresholds',
  thresholdsNote:
    'Read only in this release. A value that is not its default is marked, and so is one that could keep its rule from ever firing.',
  changesHeading: 'Change history',
  noChanges: 'No switch, threshold or planned check has been changed.',
  changesTruncated: (n: number) => `The newest ${n} changes are listed.`,
  latestChangesHeading: 'Who set each value in force',
  columns: {
    when: 'When',
    alert: 'Alert',
    phase: 'Phase',
    counts: 'Counts',
    would: 'What was recorded, and what would have been sent',
    respond: 'How to respond',
    setting: 'Setting',
    value: 'Value',
    defaultValue: 'Default',
    from: 'From',
    to: 'To',
    who: 'Who',
  },
  // The heartbeat.
  notRunYet: 'The alert job has not run yet. It checks every 10 minutes.',
  lastChecked: (time: string) => `Last checked at ${time}.`,
  noGoodCheckYet: 'No check has finished its work yet.',
  running: (time: string) => `A check started at ${time} and is still running.`,
  lastFailed: (time: string) =>
    `The latest check, started at ${time}, did not finish its work: it failed or ran out of time. The next one picks up what it left.`,
  partial:
    'The latest check could not check fully: its read was cut short or one of its lists was full. Serious flags dated before the start of that read could not be checked, and no alert was ended by it.',
  missed: (time: string) =>
    `Checks are being missed: the latest one started at ${time}, and the job should run every 10 minutes.`,
  failures: (n: number) => `${n} checks in a row were missed or failed.`,
  failureReported: (time: string) => `That was last reported at ${time}.`,
  // The spike rule.
  spikeNoBaseline:
    'Spike rule: no baseline has been computed yet, so the spike rule is not judged. The baseline is computed once a day.',
  spikeBaseline: (time: string, events: number, sources: number, days: number) =>
    `Spike baseline, computed at ${time}: the week's high mark is ${events.toLocaleString('en-US')} events and ${sources.toLocaleString('en-US')} sources in 10 minutes. The spike rule is not judged until the record is ${days} days old.`,
  spikeShortened:
    'That week held more rows than the baseline reads, so it was read from a later start.',
  // The budget.
  budget: (b: SecurityAlertList['budget'], t: AlertThresholds) =>
    `Push slots used: serious flags ${b.seriousPushesLastHour} of ${t.serious_pushes_per_hour} in the last hour; volume and record alerts ${b.volumePushesLastDay} of ${t.volume_pushes_per_day} in the last 24 hours. Counted as if push were on.`,
  plannedCheck: (time: string) =>
    `A planned check is on until ${time}: volume and record alerts are held, never a serious flag.`,
} as const;

const RULE_LABELS: Readonly<Record<AlertRule, string>> = {
  serious_flag: 'Serious flag',
  aimed_guessing: 'Guessing aimed at one organization',
  spike: 'Spike in blocked activity',
  record_trouble: 'The record is flooding',
  alerts_held: 'Alerts are being held',
};
const CLASS_LABELS: Readonly<Record<AlertClass, string>> = {
  serious: 'Serious',
  volume: 'Volume',
  record: 'Record',
  notice: 'Notice',
};
export const securityAlertRuleLabel = (rule: AlertRule): string => RULE_LABELS[rule];
export const securityAlertClassLabel = (c: AlertClass): string => CLASS_LABELS[c];

const STEP_WORDS: Readonly<Record<AlertReminderStep, string>> = {
  '1h': 'Reminder: 1 hour on',
  '6h': 'Reminder: 6 hours on',
  '24h': 'Reminder: 24 hours on',
};

/** The phase in words: started, a reminder with its step, or ended. */
export function securityAlertPhaseLabel(
  alert: Pick<SecurityAlertRow, 'phase' | 'eventKey'>,
): string {
  if (alert.phase === 'started') return 'Started';
  if (alert.phase === 'ended') return 'Ended';
  const parsed = parseAlertReminderKey(alert.eventKey);
  return parsed ? STEP_WORDS[parsed.step] : 'Reminder';
}

/**
 * What the alert is about, in words: a serious flag's reason (a flood row
 * says that something was flagged during a flood and its kind could not be
 * listed), or the rule.
 */
export function securityAlertWhat(alert: Pick<SecurityAlertRow, 'rule' | 'eventKey'>): string {
  if (alert.rule === 'serious_flag') {
    const parsed = parseAlertSeriousKey(alert.eventKey);
    if (!parsed) return RULE_LABELS.serious_flag;
    if ((FLOOD_REASONS as readonly string[]).includes(parsed.reason)) {
      return 'Something was flagged during a flood, and its kind could not be listed';
    }
    return securityEventReasonLabel(parsed.reason);
  }
  return RULE_LABELS[alert.rule];
}

/** The instant the alert's events start: a serious flag's hour, a state's start bucket; null otherwise. */
export function securityAlertEventsFromMs(
  alert: Pick<SecurityAlertRow, 'rule' | 'eventKey' | 'phase'>,
): number | null {
  if (alert.rule === 'serious_flag') return parseAlertSeriousKey(alert.eventKey)?.hourMs ?? null;
  if (alert.phase === 'reminder') return parseAlertReminderKey(alert.eventKey)?.stateMs ?? null;
  return alertBucketKeyMs(alert.eventKey);
}

const DISPOSITION_WORDS: Readonly<Record<AlertDisposition, string>> = {
  record_only: 'Recorded only: no alert channel was on, so nothing was handed out to be sent.',
  sent: 'Handed out to be sent.',
  email_only_budget: 'Handed out by email only: push was on and its budget was spent.',
  held_planned_check: 'Held: a planned check was on, so it was recorded and not handed out.',
  held_for_summary:
    'Held for the daily summary: a channel was on but its budgets were spent. The daily summary is not built yet in this release, so nothing has listed it.',
  held_with_notice:
    'Held: a channel was on but its budgets were spent and the daily summary is off, so an "alerts are being held" notice stands for it.',
  not_sent: 'Not sent: it was handed out, and no result came back after its one retry.',
};

/** What the database recorded for the alert, in plain words. */
export function securityAlertDispositionWords(disposition: AlertDisposition): string {
  return DISPOSITION_WORDS[disposition];
}

const PUSH_CODE_WORDS: Readonly<Record<PushResultCode, string>> = {
  sent: 'reached',
  failed: 'failed',
  timeout: 'timed out',
  no_account: 'no account',
  no_phone: 'no phone',
  skipped: 'skipped (this release sends nothing)',
};
const EMAIL_CODE_WORDS: Readonly<Record<EmailResultCode, string>> = {
  sent: 'reached',
  failed: 'failed',
  timeout: 'timed out',
  skipped: 'skipped (this release sends nothing)',
};

/** A channel's result in words ("Push: skipped (this release sends nothing) 2"), or null. */
export function securityAlertResultWords(
  channel: 'push' | 'email',
  result: AlertPushResult | AlertEmailResult | null,
): string | null {
  if (result === null) return null;
  const words = channel === 'push' ? PUSH_CODE_WORDS : EMAIL_CODE_WORDS;
  const parts = Object.entries(result)
    .filter(([, n]) => typeof n === 'number')
    .map(([code, n]) => `${n} ${(words as Record<string, string>)[code] ?? code}`);
  return `${channel === 'push' ? 'Push' : 'Email'}: ${parts.join(', ')}`;
}

/**
 * EVERYTHING THE PAGE SAYS ABOUT ONE ALERT'S SENDING, as plain lines: what
 * the database recorded, why a serious flag's email went with email alerts
 * off, the held notice, each channel's result, and, for an alert recorded
 * only, what it would have done with a channel on, as far as the record can
 * say (the push budget only: it is counted with every switch off; the email
 * caps and the held choices are not, so nothing is said of them beyond
 * that).
 */
export function securityAlertSendingLines(alert: SecurityAlertRow): string[] {
  const channels = [alert.pushPlanned ? 'push' : null, alert.emailPlanned ? 'email' : null]
    .filter(Boolean)
    .join(' and ');
  const lines: string[] = [
    alert.disposition === 'sent' && channels !== ''
      ? `Handed out to be sent by ${channels}.`
      : DISPOSITION_WORDS[alert.disposition],
  ];
  if (alert.rule === 'alerts_held') {
    const held = typeof alert.counts.held === 'number' ? alert.counts.held : null;
    lines.push(
      held === null
        ? 'An "alerts are being held" notice would have been sent.'
        : `An "alerts are being held" notice would have been sent: ${held.toLocaleString('en-US')} ${held === 1 ? 'alert was' : 'alerts were'} held in the last 24 hours.`,
    );
  }
  if (alert.emailFloor === 'push_budget_spent') {
    lines.push(
      'Would have gone by email although email alerts are off, because the push budget was spent.',
    );
  } else if (alert.emailFloor === 'push_failed') {
    lines.push('Its push reached no one, so its email would have gone in its place.');
  }
  if (alert.disposition === 'not_sent' && channels !== '') {
    lines.push(`It was handed out for ${channels}.`);
  }
  const push = securityAlertResultWords('push', alert.pushResult);
  const email = securityAlertResultWords('email', alert.emailResult);
  if (push) lines.push(push);
  if (email) lines.push(email);
  if (alert.overdue) {
    lines.push(
      alert.attempts === 1
        ? 'No result 5 minutes after it was handed out: it will be handed out once more.'
        : 'No result after its one retry either: it will be marked not sent.',
    );
  } else if (alert.awaitingResult) {
    lines.push('Waiting for its result.');
  }
  if (alert.disposition === 'record_only') {
    lines.push(...wouldHaveLines(alert));
  }
  return lines;
}

function wouldHaveLines(alert: SecurityAlertRow): string[] {
  if (alert.rule === 'alerts_held') return [];
  const out: string[] = [];
  if (alert.phase === 'ended') {
    out.push('With push on: no push (an end never pushes).');
  } else if (alert.pushCounted) {
    out.push('With push on: a push (a slot of its budget was free).');
  } else if (alert.class === 'serious') {
    out.push(
      'With push on: no push slot was left (its hour, or its reason for the day, was spent), so it would have gone by email, even with email alerts off.',
    );
  } else {
    out.push('With push on: no push slot was left today, so it would not have pushed.');
  }
  out.push(
    alert.class === 'serious'
      ? "With email on: an email (a serious flag's email is never capped or held)."
      : "With email on: an email, unless the day's email cap for its kind was reached. That cap is not counted while email is off.",
  );
  return out;
}

const COUNT_KEY_WORDS: Readonly<Record<string, string>> = {
  events: 'events',
  sources: 'sources',
  rows: 'flood rows',
  minutes: 'minutes',
  held: 'held',
  event_mark: 'event mark',
  source_mark: 'source mark',
  quiet_minutes: 'quiet minutes',
};
const COUNT_FLAG_WORDS: Readonly<Record<string, string>> = {
  at_least: 'at least (a floor)',
  tally: "our own server's count",
  flagged_in_flood: 'flagged during a flood',
};

/** An alert's counts in words: "120 events · 14 sources · at least (a floor)". Only true flags are said. */
export function securityAlertCountsWords(counts: AlertCounts): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'boolean') {
      if (value) parts.push(COUNT_FLAG_WORDS[key] ?? key.replace(/_/g, ' '));
      continue;
    }
    const label = COUNT_KEY_WORDS[key] ?? key.replace(/_/g, ' ');
    if (typeof value === 'number') parts.push(`${value.toLocaleString('en-US')} ${label}`);
    else if (typeof value === 'string') parts.push(`${label}: ${value.replace(/_/g, ' ')}`);
    else if (Array.isArray(value)) parts.push(`${label}: ${value.join(', ')}`);
    else
      parts.push(
        `${label}: ${Object.entries(value as Record<string, number>)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ')}`,
      );
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** The card that answers an alert, where one maps: a serious flag's reason, guessing, record trouble. */
export function securityAlertCardId(
  alert: Pick<SecurityAlertRow, 'rule' | 'eventKey'>,
): SecurityResponseCardId | null {
  if (alert.rule === 'serious_flag') {
    return securityResponseCardIdFor(parseAlertSeriousKey(alert.eventKey)?.reason ?? null);
  }
  if (alert.rule === 'aimed_guessing') return securityResponseCardIdFor('repeated_wrong_password');
  if (alert.rule === 'record_trouble') return securityResponseCardIdFor('over_minute_cap');
  return null;
}

const THRESHOLD_LABELS: Readonly<Record<AlertThresholdName, string>> = {
  aimed_guessing_events: 'Guessing aimed at one organization: events',
  aimed_guessing_minutes: 'Guessing aimed at one organization: within minutes',
  record_trouble_rows: 'Record trouble: flood rows in 10 minutes',
  serious_pushes_per_hour: 'Serious flags: pushes an hour',
  serious_reason_pushes_per_day: 'Serious flags: pushes a day for one reason',
  spike_event_floor: 'Spike: at least this many events in 10 minutes',
  spike_learning_days: 'Spike: days of record before it is judged',
  spike_source_floor: 'Spike: at least this many sources',
  subject_pushes_per_day: 'Volume and record: pushes a day for one rule and subject',
  volume_pushes_per_day: 'Volume and record: pushes a day',
};
/** The thresholds that decide when a rule fires: at their most, that rule may never fire. */
const TRIGGER_THRESHOLDS: readonly AlertThresholdName[] = [
  'aimed_guessing_events',
  'record_trouble_rows',
  'spike_event_floor',
  'spike_source_floor',
  'spike_learning_days',
];

export interface SecurityAlertThresholdRow {
  name: AlertThresholdName;
  label: string;
  value: number;
  defaultValue: number;
  range: readonly [number, number];
  differs: boolean;
  /** Set where its rule may never fire, or no volume or record alert can push. */
  warning: string | null;
}

/** The ten thresholds as the page lists them, each marked where it is not its default or is unsafe. */
export function securityAlertThresholdRows(
  thresholds: AlertThresholds,
): SecurityAlertThresholdRow[] {
  return ALERT_THRESHOLD_NAMES.map((name) => {
    const value = thresholds[name];
    const range = ALERT_THRESHOLD_RANGES[name];
    let warning: string | null = null;
    if (TRIGGER_THRESHOLDS.includes(name) && value >= range[1]) {
      warning = 'At its most: its rule may never fire.';
    } else if (name === 'volume_pushes_per_day' && value === 0) {
      warning = 'At 0: no volume or record alert can push.';
    }
    return {
      name,
      label: THRESHOLD_LABELS[name],
      value,
      defaultValue: ALERT_THRESHOLD_DEFAULTS[name],
      range,
      differs: value !== ALERT_THRESHOLD_DEFAULTS[name],
      warning,
    };
  });
}

const SWITCH_LABELS: Readonly<Record<AlertSwitch, string>> = {
  email_on: 'Email alerts',
  push_on: 'Push alerts',
  summary_on: 'Daily summary',
};

/** A change's setting in words. */
export function securityAlertChangeLabel(name: AlertChangeName): string {
  if ((ALERT_SWITCHES as readonly string[]).includes(name))
    return SWITCH_LABELS[name as AlertSwitch];
  if (name === 'planned_check') return 'Planned check';
  return THRESHOLD_LABELS[name as AlertThresholdName];
}

/**
 * A change's value in words: a switch on or off, a planned check's end (the
 * page formats the time in the viewer's zone and hands it in) or none, a
 * threshold's number.
 */
export function securityAlertChangeValueWords(
  name: AlertChangeName,
  value: AlertChangeValue,
  formatTime: (iso: string) => string,
): string {
  if ((ALERT_SWITCHES as readonly string[]).includes(name)) return value === true ? 'On' : 'Off';
  if (name === 'planned_check')
    return typeof value === 'string' ? `Until ${formatTime(value)}` : 'None';
  return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
}

/** The state of the alert job, as the page says it: which lines, and whether any is a warning. */
export interface SecurityAlertsHeartbeatSay {
  /** Never ran; or the last good check's time. */
  lastChecked: { kind: 'never' } | { kind: 'never_ok' } | { kind: 'at'; at: string };
  running: string | null;
  lastFailed: string | null;
  partial: boolean;
  missed: string | null;
  failures: number | null;
  failureReportedAt: string | null;
  warning: boolean;
}

/** What the page says of the job's heartbeat at `nowMs` (the read's own time). */
export function securityAlertsHeartbeatSay(
  hb: SecurityAlertHeartbeat,
  nowMs: number,
): SecurityAlertsHeartbeatSay {
  const started = hb.lastRunStartedAt === null ? NaN : Date.parse(hb.lastRunStartedAt);
  const lastChecked: SecurityAlertsHeartbeatSay['lastChecked'] =
    hb.lastRunStartedAt === null
      ? { kind: 'never' }
      : hb.lastOkAt === null
        ? { kind: 'never_ok' }
        : { kind: 'at', at: hb.lastOkAt };
  const unfinished = hb.lastRunStartedAt !== null && hb.lastRunFinishedAt === null;
  const running =
    unfinished &&
    Number.isFinite(started) &&
    nowMs - started <= ALERT_RUN_LONGEST_MINUTES * MINUTE_MS
      ? hb.lastRunStartedAt
      : null;
  const lastFailed =
    hb.lastRunStartedAt !== null && (hb.lastRunOk === false || (unfinished && running === null))
      ? hb.lastRunStartedAt
      : null;
  const partial = hb.lastRunPartial === true;
  const missed =
    Number.isFinite(started) && nowMs - started > ALERT_MISSED_AFTER_MINUTES * MINUTE_MS
      ? hb.lastRunStartedAt
      : null;
  const failures = hb.failuresInARow >= ALERT_REPORT_AFTER_FAILURES ? hb.failuresInARow : null;
  return {
    lastChecked,
    running,
    lastFailed,
    partial,
    missed,
    failures,
    failureReportedAt: failures !== null ? hb.failureReportedAt : null,
    warning:
      lastChecked.kind !== 'at' ||
      lastFailed !== null ||
      partial ||
      missed !== null ||
      failures !== null,
  };
}
