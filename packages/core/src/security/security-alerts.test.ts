import { describe, expect, it, vi } from 'vitest';

import {
  ADMIN_EMAILS_MOST,
  AIMED_REASONS,
  ALERT_ABANDON_AFTER_MINUTES,
  ALERT_BUCKET_SECONDS,
  ALERT_CHANGE_NAMES,
  ALERT_CLAIM_KEYS,
  ALERT_CLAIM_REFUSALS,
  ALERT_DISPOSITIONS,
  ALERT_EMAIL_FLOORS,
  ALERT_HELD_NOTICE_GAP_HOURS,
  ALERT_LIST_DEFAULT,
  ALERT_LIST_MOST,
  ALERT_OUTCOMES,
  ALERT_PHASES,
  ALERT_RECORD_EMAILS_PER_DAY,
  ALERT_REMINDER_STEPS,
  ALERT_REPORT_AFTER_FAILURES,
  ALERT_REPORT_GAP_HOURS,
  ALERT_RESULT_REFUSALS,
  ALERT_RETRY_AFTER_MINUTES,
  ALERT_RULES,
  ALERT_SERIOUS_ABANDON_AFTER_HOURS,
  ALERT_SWITCHES,
  ALERT_THRESHOLD_DEFAULTS,
  ALERT_THRESHOLD_RANGES,
  ALERT_VOLUME_EMAILS_PER_DAY,
  ALERT_WINDOW_HOURS,
  EMAIL_RESULT_CODES,
  FLOOD_REASONS,
  PLANNED_CHECK_GAP_MINUTES,
  PLANNED_CHECK_MOST_MINUTES,
  PLANNED_CHECKS_PER_DAY,
  PUSH_RESULT_CODES,
  SERIOUS_REASONS,
  TROUBLE_REASONS,
  alertBucketKey,
  alertBucketKeyMs,
  alertReminderKey,
  alertSeriousKey,
  dueReminderStep,
  isAlertCounts,
  isAlertKeyFor,
  nextStartKey,
  parseAlertReminderKey,
  parseAlertSeriousKey,
  planSecurityAlerts,
  readSecurityAlertBaseline,
  readSecurityAlertClaim,
  readSecurityAlertHeartbeatFinish,
  readSecurityAlertHeartbeatStart,
  readSecurityAlertInputs,
  readSecurityAlertList,
  readSecurityAlertResult,
  recordOnlyResult,
  securityAlertCardId,
  securityAlertChangeLabel,
  securityAlertChangeValueWords,
  securityAlertClaimOrder,
  securityAlertCountsWords,
  securityAlertDispositionWords,
  securityAlertPhaseLabel,
  securityAlertSendingLines,
  securityAlertsHeartbeatSay,
  securityAlertSpikeHeld,
  securityAlertThresholdRows,
  securityAlertWhat,
  type AlertClaimAsk,
  type SecurityAlertInputs,
  type SecurityAlertPlan,
  type SecurityAlertRow,
} from './security-alerts';

/**
 * The platform console's security alerts, the pure half (stage 4a, record
 * only). Security invariant: the rules an attacker would play against (wake
 * the owner all night, bury a serious flag) are pinned here at the rule
 * level, by name: serious flags are always claimed first; a condition that
 * lasts is one state with at most three reminders, never two in one run;
 * an end needs 30 quiet minutes and a whole read; keys come from the events,
 * never from a clock; the spike rule is held with no baseline or a young
 * record; a shape the database does not answer is "could not check".
 *
 * Made-up data only: organization ids are made-up uuids, times are 2026.
 */

/* ───────────────────────────── a made-up database answer ───────────────────────────── */

const MIN = 60_000;
const BUCKET = 10 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 2026-11-24T12:05:30Z: the database's now in most tests. */
const NOW = Date.UTC(2026, 10, 24, 12, 5, 30);
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';

/** A time as Postgres writes a timestamptz into jsonb with the zone UTC. */
const pg = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const binOf = (ms: number) => Math.floor(ms / BUCKET) * BUCKET;
const key = (ms: number) => alertBucketKey(ms)!;

interface RawOptions {
  now?: number;
  buckets?: Record<number, { events?: number; sources?: number; troubleRows?: number }>;
  aimed?: Array<{ org: string; cells: Record<number, number> }>;
  serious?: Array<{ reason: string; hour: number; events?: number; flood?: boolean }>;
  openStates?: Array<{
    rule: string;
    subject?: string;
    key: string;
    reminders?: string[];
    held?: boolean;
  }>;
  seriousRetry?: string[];
  retry?: Array<{ rule: string; subject?: string; key: string; phase: string }>;
  thresholds?: Partial<Record<keyof typeof ALERT_THRESHOLD_DEFAULTS, number>>;
  baseline?: { eventHigh: number | null; sourceHigh: number | null; computedAt: number | null };
  oldest?: number | null;
  shortenedFrom?: number;
  truncated?: Partial<Record<'aimed' | 'open' | 'seriousRetry' | 'retry', boolean>>;
}

/** The inputs answer, shaped as platform_security_alert_inputs() answers it. */
function rawInputs(o: RawOptions = {}): Record<string, unknown> {
  const now = o.now ?? NOW;
  const askedFrom = binOf(now - 8 * HOUR) + BUCKET;
  const from = o.shortenedFrom ?? askedFrom;
  const thresholds = { ...ALERT_THRESHOLD_DEFAULTS, ...o.thresholds };
  const baseline = o.baseline ?? { eventHigh: 30, sourceHigh: 4, computedAt: now - 2 * HOUR };
  const buckets = [];
  for (let b = binOf(from); b <= binOf(now); b += BUCKET) {
    const v = o.buckets?.[b] ?? {};
    buckets.push({
      bucket_start: pg(b),
      bucket_key: key(b),
      partial: b < from || b + BUCKET > now,
      events: v.events ?? 0,
      sources: v.sources ?? 0,
      trouble_rows: v.troubleRows ?? 0,
      trouble_events: (v.troubleRows ?? 0) * 7,
    });
  }
  return {
    serious: (o.serious ?? []).map((s) => ({
      reason: s.reason,
      hour: pg(s.hour),
      event_key: alertSeriousKey(s.reason, s.hour),
      flagged_in_flood: s.flood ?? false,
      events: s.events ?? 3,
      at_least: false,
      tally: false,
      first_minute: pg(s.hour + 5 * MIN),
      last_minute: pg(s.hour + 9 * MIN),
    })),
    aimed: (o.aimed ?? []).map((a) => ({
      organization_id: a.org,
      events: Object.values(a.cells).reduce((x, y) => x + y, 0),
      buckets: Object.entries(a.cells).map(([start, events]) => ({
        bucket_start: pg(Number(start)),
        bucket_key: key(Number(start)),
        events,
      })),
    })),
    aimed_truncated: o.truncated?.aimed ?? false,
    buckets,
    open_states: (o.openStates ?? []).map((s) => ({
      rule: s.rule,
      subject: s.subject ?? '',
      event_key: s.key,
      started_claimed_at: pg((alertBucketKeyMs(s.key) ?? now) + 10 * MIN + 30_000),
      held: s.held ?? false,
      reminders: s.reminders ?? [],
    })),
    open_states_truncated: o.truncated?.open ?? false,
    serious_retry_due: (o.seriousRetry ?? []).map((k) => ({
      rule: 'serious_flag',
      subject: '',
      event_key: k,
      phase: 'started',
      claimed_at: pg(now - 7 * MIN),
    })),
    serious_retry_due_truncated: o.truncated?.seriousRetry ?? false,
    retry_due: (o.retry ?? []).map((r) => ({
      rule: r.rule,
      subject: r.subject ?? '',
      event_key: r.key,
      phase: r.phase,
      claimed_at: pg(now - 6 * MIN),
    })),
    retry_due_truncated: o.truncated?.retry ?? false,
    window: { from: pg(from), to: pg(now + MIN), asked_from: pg(askedFrom) },
    shortened: from > askedFrom,
    refused: null,
    generated_at: pg(now),
    bucket_seconds: 600,
    oldest_event_at:
      o.oldest === undefined ? pg(now - 20 * DAY) : o.oldest === null ? null : pg(o.oldest),
    thresholds,
    baseline: {
      event_high: baseline.eventHigh,
      source_high: baseline.sourceHigh,
      event_mark: Math.max(baseline.eventHigh ?? 0, thresholds.spike_event_floor),
      source_mark: Math.max(baseline.sourceHigh ?? 0, thresholds.spike_source_floor),
      from: baseline.computedAt === null ? null : pg(baseline.computedAt - 7 * DAY),
      to: baseline.computedAt === null ? null : pg(baseline.computedAt),
      shortened: baseline.computedAt === null ? null : false,
      computed_at: baseline.computedAt === null ? null : pg(baseline.computedAt),
    },
    switches: { email_on: false, push_on: false, summary_on: false },
    planned_check_until: null,
  };
}

function inputs(o: RawOptions = {}): SecurityAlertInputs {
  const read = readSecurityAlertInputs(rawInputs(o));
  if (!read.ok || read.value === null)
    throw new Error(`fixture unreadable: ${JSON.stringify(read)}`);
  return read.value;
}
const plan = (o: RawOptions = {}) => planSecurityAlerts(inputs(o));

/** The latest whole bucket at NOW (12:05:30): 11:50. The bucket running now: 12:00. */
const JUDGED = binOf(NOW) - BUCKET;
/** Three whole buckets ending at the judged one: the default 30 minutes. */
const LAST3 = [JUDGED - 2 * BUCKET, JUDGED - BUCKET, JUDGED];

/* ─────────────────────────────── the contract's constants ─────────────────────────────── */

describe("the database's constants, exactly as CONTRACT.md gives them", () => {
  it('rules, phases, steps, outcomes, dispositions, floors', () => {
    expect(ALERT_RULES).toEqual({
      serious_flag: 'serious',
      spike: 'volume',
      aimed_guessing: 'volume',
      record_trouble: 'record',
      alerts_held: 'notice',
    });
    expect(ALERT_PHASES).toEqual(['started', 'reminder', 'ended']);
    expect(ALERT_REMINDER_STEPS).toEqual(['1h', '6h', '24h']);
    expect(ALERT_OUTCOMES).toEqual(['new', 'retry', 'duplicate', 'not_sent', 'refused']);
    expect(ALERT_DISPOSITIONS).toEqual([
      'sent',
      'email_only_budget',
      'record_only',
      'held_planned_check',
      'held_for_summary',
      'held_with_notice',
      'not_sent',
    ]);
    expect(ALERT_EMAIL_FLOORS).toEqual(['push_budget_spent', 'push_failed']);
    expect(ALERT_CLAIM_KEYS).toHaveLength(9);
    expect(ALERT_CLAIM_REFUSALS).toHaveLength(12);
    expect(ALERT_RESULT_REFUSALS).toHaveLength(8);
  });

  it('the reasons', () => {
    expect(SERIOUS_REASONS).toEqual([
      'passkey_counter_went_back',
      'passkey_unexplained_sign_in',
      'sign_in_not_me',
      'unrecorded_server_form_password',
      'unrecorded_server_form_code',
    ]);
    expect(FLOOD_REASONS).toEqual(['over_minute_cap', 'over_buffer_cap', 'auth_log_over_cap']);
    expect(AIMED_REASONS).toEqual([
      'repeated_wrong_password',
      'repeated_wrong_code',
      'sign_in_paused',
      'code_checks_paused',
    ]);
    expect(TROUBLE_REASONS).toEqual(['over_minute_cap', 'over_buffer_cap']);
  });

  it('the ten thresholds, their defaults and their ranges; fourteen change names', () => {
    expect(ALERT_THRESHOLD_DEFAULTS).toEqual({
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
    });
    expect(ALERT_THRESHOLD_RANGES).toEqual({
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
    });
    expect(ALERT_SWITCHES).toEqual(['email_on', 'push_on', 'summary_on']);
    expect(ALERT_CHANGE_NAMES).toHaveLength(14);
    expect(PLANNED_CHECK_MOST_MINUTES).toBe(30);
  });

  it('the windows, caps and codes', () => {
    expect([
      ALERT_BUCKET_SECONDS,
      ALERT_WINDOW_HOURS,
      ALERT_RETRY_AFTER_MINUTES,
      ALERT_ABANDON_AFTER_MINUTES,
      ALERT_SERIOUS_ABANDON_AFTER_HOURS,
      ALERT_REPORT_AFTER_FAILURES,
      ALERT_REPORT_GAP_HOURS,
      ALERT_VOLUME_EMAILS_PER_DAY,
      ALERT_RECORD_EMAILS_PER_DAY,
      ALERT_HELD_NOTICE_GAP_HOURS,
      PLANNED_CHECK_GAP_MINUTES,
      PLANNED_CHECKS_PER_DAY,
      ALERT_LIST_DEFAULT,
      ALERT_LIST_MOST,
      ADMIN_EMAILS_MOST,
    ]).toEqual([600, 8, 5, 30, 10, 3, 6, 24, 6, 6, 30, 4, 50, 200, 20]);
    expect(PUSH_RESULT_CODES).toEqual([
      'sent',
      'failed',
      'timeout',
      'no_account',
      'no_phone',
      'skipped',
    ]);
    expect(EMAIL_RESULT_CODES).toEqual(['sent', 'failed', 'timeout', 'skipped']);
  });
});

/* ─────────────────────────────────────── keys ─────────────────────────────────────── */

describe('keys, from the events only', () => {
  it('a bucket key is the UTC bucket, minutes in tens, read back to the same time', () => {
    const at = Date.UTC(2026, 10, 24, 10, 20);
    expect(alertBucketKey(at)).toBe('2026-11-24T10:20Z');
    expect(alertBucketKeyMs('2026-11-24T10:20Z')).toBe(at);
    expect(alertBucketKey(at + MIN)).toBeNull();
    for (const bad of [
      '2026-11-24T10:25Z',
      '2026-11-24T24:00Z',
      '2026-02-30T10:20Z',
      '2026-11-24T10:20',
      'x',
      7,
    ]) {
      expect(alertBucketKeyMs(bad), String(bad)).toBeNull();
    }
  });

  it("a serious flag's key is its reason and the event's UTC hour", () => {
    const hour = Date.UTC(2026, 10, 24, 9);
    expect(alertSeriousKey('sign_in_not_me', hour)).toBe('sign_in_not_me|2026-11-24T09:00Z');
    expect(alertSeriousKey('sign_in_not_me', hour + MIN)).toBeNull();
    expect(alertSeriousKey('Not-A-Word', hour)).toBeNull();
    expect(parseAlertSeriousKey('sign_in_not_me|2026-11-24T09:00Z')).toEqual({
      reason: 'sign_in_not_me',
      hourMs: hour,
    });
    expect(parseAlertSeriousKey('sign_in_not_me|2026-11-24T09:10Z')).toBeNull();
  });

  it("a reminder's key is the state's key and its step", () => {
    expect(alertReminderKey('2026-11-24T10:20Z', '6h')).toBe('2026-11-24T10:20Z+6h');
    expect(parseAlertReminderKey('2026-11-24T10:20Z+6h')?.step).toBe('6h');
    expect(parseAlertReminderKey('2026-11-24T10:20Z+2h')).toBeNull();
  });

  it('the keys the claim takes, by rule and phase', () => {
    expect(isAlertKeyFor('serious_flag', 'started', 'sign_in_not_me|2026-11-24T09:00Z')).toBe(true);
    expect(isAlertKeyFor('serious_flag', 'started', 'over_minute_cap|2026-11-24T09:00Z')).toBe(
      true,
    );
    expect(isAlertKeyFor('serious_flag', 'started', 'wrong_password|2026-11-24T09:00Z')).toBe(
      false,
    );
    expect(isAlertKeyFor('serious_flag', 'ended', 'sign_in_not_me|2026-11-24T09:00Z')).toBe(false);
    expect(isAlertKeyFor('spike', 'reminder', '2026-11-24T10:20Z+1h')).toBe(true);
    expect(isAlertKeyFor('spike', 'reminder', '2026-11-24T10:20Z')).toBe(false);
    expect(isAlertKeyFor('spike', 'ended', '2026-11-24T10:20Z')).toBe(true);
    expect(isAlertKeyFor('alerts_held', 'reminder', '2026-11-24T10:20Z')).toBe(false);
  });

  it("the plan is the same whatever this machine's clock says: no key comes from it", () => {
    const o: RawOptions = {
      aimed: [{ org: ORG_A, cells: Object.fromEntries(LAST3.map((b) => [b, 10])) }],
      buckets: { [JUDGED]: { troubleRows: 2 } },
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 9) }],
    };
    const spy = vi.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(Date.UTC(2030, 0, 1));
      const a = plan(o);
      spy.mockReturnValue(Date.UTC(2020, 5, 5, 3, 3, 3));
      const b = plan(o);
      expect(a).toEqual(b);
      // Record trouble in the judged bucket; guessing that reached 20 in the window ending one before.
      expect(a.conditions.map((c) => c.eventKey)).toEqual([key(JUDGED), key(JUDGED - BUCKET)]);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ────────────────────────────────────── readers ────────────────────────────────────── */

describe('the inputs reader: the contract shape or "could not check"', () => {
  it('reads a whole answer', () => {
    const read = readSecurityAlertInputs(rawInputs());
    expect(read.ok && read.value !== null).toBe(true);
    if (!read.ok || !read.value) return;
    // 04:10 (the first whole bucket within 8 hours) to 12:00 (the bucket running now).
    expect(read.value.buckets.length).toBe(48);
    expect(read.value.nowMs).toBe(NOW);
  });

  it('reads the two refusals', () => {
    for (const refused of ['no_state', 'too_many_events_in_one_minute']) {
      expect(readSecurityAlertInputs({ window: null, refused, generated_at: pg(NOW) })).toEqual({
        ok: true,
        value: null,
        refused,
      });
    }
    expect(
      readSecurityAlertInputs({ window: null, refused: 'other', generated_at: pg(NOW) }).ok,
    ).toBe(false);
  });

  it.each([
    [
      'a key less',
      (r: Record<string, unknown>) => {
        const { buckets: _b, ...rest } = r;
        return rest;
      },
    ],
    [
      'a refused word beside a window',
      (r: Record<string, unknown>) => ({ ...r, refused: 'no_state' }),
    ],
    ['another bucket size', (r: Record<string, unknown>) => ({ ...r, bucket_seconds: 60 })],
    [
      'shortened that the window does not say',
      (r: Record<string, unknown>) => ({ ...r, shortened: true }),
    ],
    [
      'a threshold missing',
      (r: Record<string, unknown>) => ({ ...r, thresholds: { aimed_guessing_events: 20 } }),
    ],
    [
      'a bucket key that is not its start',
      (r: Record<string, unknown>) => ({
        ...r,
        buckets: [
          { ...(r.buckets as Array<Record<string, unknown>>)[0], bucket_key: '2026-11-24T00:00Z' },
        ],
      }),
    ],
    [
      'a serious key that is not its reason and hour',
      (r: Record<string, unknown>) => ({
        ...r,
        serious: [
          {
            ...(
              rawInputs({
                serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 9) }],
              }).serious as Array<Record<string, unknown>>
            )[0],
            event_key: 'sign_in_not_me|2026-11-24T10:00Z',
          },
        ],
      }),
    ],
    [
      'a serious reason outside the five',
      (r: Record<string, unknown>) => ({
        ...r,
        serious: [
          {
            ...(
              rawInputs({
                serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 9) }],
              }).serious as Array<Record<string, unknown>>
            )[0],
            reason: 'wrong_password',
            event_key: 'wrong_password|2026-11-24T09:00Z',
          },
        ],
      }),
    ],
    [
      'an organization that is not a uuid',
      (r: Record<string, unknown>) => ({
        ...r,
        aimed: [{ organization_id: 'org-a', events: 1, buckets: [] }],
      }),
    ],
    [
      'a negative count',
      (r: Record<string, unknown>) => ({
        ...r,
        buckets: [{ ...(r.buckets as Array<Record<string, unknown>>)[0], events: -1 }],
      }),
    ],
    [
      'a serious retry in the volume list',
      (r: Record<string, unknown>) => ({
        ...r,
        retry_due: [
          {
            rule: 'serious_flag',
            subject: '',
            event_key: 'sign_in_not_me|2026-11-24T09:00Z',
            phase: 'started',
            claimed_at: pg(NOW),
          },
        ],
      }),
    ],
    [
      'a reminder step the database never claims',
      (r: Record<string, unknown>) => ({
        ...r,
        open_states: [
          {
            rule: 'spike',
            subject: '',
            event_key: '2026-11-24T10:20Z',
            started_claimed_at: pg(NOW),
            held: false,
            reminders: ['2h'],
          },
        ],
      }),
    ],
    ['not an object', () => 'nothing'],
  ])('%s is not read', (_what, change) => {
    const read = readSecurityAlertInputs(change(rawInputs()));
    expect(read.ok).toBe(false);
  });
});

describe('the claim reader: always the nine keys, each as its outcome allows', () => {
  const base = {
    outcome: 'new',
    refused: null,
    id: '11111111-1111-4111-8111-111111111111',
    disposition: 'record_only',
    push: false,
    email: false,
    attempt: 1,
    open_key: null,
    notice: null,
  };
  it('reads new, retry, duplicate (with and without its row), not_sent and refused', () => {
    expect(readSecurityAlertClaim(base).ok).toBe(true);
    expect(
      readSecurityAlertClaim({
        ...base,
        outcome: 'retry',
        attempt: 2,
        push: true,
        disposition: 'sent',
      }).ok,
    ).toBe(true);
    expect(readSecurityAlertClaim({ ...base, outcome: 'duplicate', disposition: 'sent' }).ok).toBe(
      true,
    );
    expect(
      readSecurityAlertClaim({
        ...base,
        outcome: 'duplicate',
        id: null,
        disposition: null,
        attempt: null,
      }).ok,
    ).toBe(true);
    expect(
      readSecurityAlertClaim({ ...base, outcome: 'not_sent', disposition: 'not_sent', attempt: 2 })
        .ok,
    ).toBe(true);
    for (const word of ALERT_CLAIM_REFUSALS) {
      const read = readSecurityAlertClaim({
        ...base,
        outcome: 'refused',
        refused: word,
        id: null,
        disposition: null,
        attempt: null,
        open_key: word === 'already_open' ? '2026-11-24T10:20Z' : null,
      });
      expect(read.ok, word).toBe(true);
    }
  });

  it('reads the held notice on a new held_with_notice claim only', () => {
    const notice = {
      id: '22222222-2222-4222-8222-222222222222',
      event_key: '2026-11-24T12:00Z',
      push: false,
      email: true,
      attempt: 1,
    };
    const read = readSecurityAlertClaim({ ...base, disposition: 'held_with_notice', notice });
    expect(read.ok && read.claim.notice).toEqual({
      id: notice.id,
      eventKey: notice.event_key,
      push: false,
      email: true,
      attempt: 1,
    });
    expect(readSecurityAlertClaim({ ...base, notice }).ok).toBe(false);
  });

  it.each([
    ['a refused word with another outcome', { ...base, refused: 'no_state' }],
    ['refused with no word', { ...base, outcome: 'refused' }],
    ['a duplicate that hands out a channel', { ...base, outcome: 'duplicate', push: true }],
    ['a new claim with attempt 2', { ...base, attempt: 2 }],
    ['a retry with attempt 1', { ...base, outcome: 'retry' }],
    ['a new claim with no id', { ...base, id: null }],
    [
      'a word the contract does not name',
      { ...base, outcome: 'refused', refused: 'other', id: null, disposition: null, attempt: null },
    ],
    [
      'an open key that is not a bucket',
      {
        ...base,
        outcome: 'refused',
        refused: 'already_open',
        id: null,
        disposition: null,
        attempt: null,
        open_key: 'x',
      },
    ],
    [
      'a key less',
      (() => {
        const { open_key: _gone, ...rest } = base;
        return rest;
      })(),
    ],
  ])('%s is not read', (_what, raw) => {
    expect(readSecurityAlertClaim(raw).ok).toBe(false);
  });
});

describe('the other readers', () => {
  it('the result: recorded, or one of the eight refusals', () => {
    expect(readSecurityAlertResult({ recorded: true, refused: null })).toEqual({
      ok: true,
      recorded: true,
      refused: null,
    });
    for (const word of ALERT_RESULT_REFUSALS) {
      expect(readSecurityAlertResult({ recorded: false, refused: word }).ok, word).toBe(true);
    }
    expect(readSecurityAlertResult({ recorded: true, refused: 'email_floor_due' }).ok).toBe(false);
    expect(readSecurityAlertResult({ recorded: false, refused: null }).ok).toBe(false);
  });

  const start = {
    step: 'start',
    refused: null,
    run_id: '33333333-3333-4333-8333-333333333333',
    previous: { started_at: pg(NOW - 10 * MIN), finished_at: pg(NOW - 9 * MIN), ok: true },
    last_ok_at: pg(NOW - 9 * MIN),
    missed_runs: 0,
    failures_in_a_row: 0,
    report_now: false,
    marked_not_sent: 0,
  };
  it('the heartbeat start, and its refusals', () => {
    const read = readSecurityAlertHeartbeatStart(start);
    expect(read.ok && read.value?.runId).toBe(start.run_id);
    expect(readSecurityAlertHeartbeatStart({ step: 'start', refused: 'no_state' })).toEqual({
      ok: true,
      value: null,
      refused: 'no_state',
    });
    expect(readSecurityAlertHeartbeatStart({ step: null, refused: 'not_a_step' }).ok).toBe(true);
    expect(readSecurityAlertHeartbeatStart({ ...start, run_id: null }).ok).toBe(false);
    expect(readSecurityAlertHeartbeatStart({ ...start, step: 'finish' }).ok).toBe(false);
  });

  it('the heartbeat finish, and its refusals', () => {
    expect(
      readSecurityAlertHeartbeatFinish({
        step: 'finish',
        refused: null,
        failures_in_a_row: 3,
        report_now: true,
      }),
    ).toEqual({ ok: true, refused: null, value: { failuresInARow: 3, reportNow: true } });
    for (const word of ['not_the_latest_run', 'already_finished', 'not_a_finish', 'no_state']) {
      expect(readSecurityAlertHeartbeatFinish({ step: 'finish', refused: word }).ok, word).toBe(
        true,
      );
    }
    expect(readSecurityAlertHeartbeatFinish({ step: 'finish', refused: null }).ok).toBe(false);
  });

  it('the baseline: computed, or its three refusals', () => {
    const computed = {
      computed: true,
      refused: null,
      event_high: 40,
      source_high: 6,
      from: pg(NOW - 7 * DAY),
      to: pg(NOW),
      asked_from: pg(NOW - 7 * DAY),
      shortened: false,
      buckets: 1008,
      computed_at: pg(NOW),
    };
    expect(readSecurityAlertBaseline(computed).ok).toBe(true);
    expect(
      readSecurityAlertBaseline({
        computed: false,
        refused: 'computed_recently',
        computed_at: pg(NOW),
      }).ok,
    ).toBe(true);
    expect(readSecurityAlertBaseline({ computed: false, refused: 'no_state' }).ok).toBe(true);
    expect(
      readSecurityAlertBaseline({ computed: false, refused: 'too_many_events_in_one_bucket' }).ok,
    ).toBe(true);
    expect(readSecurityAlertBaseline({ computed: false, refused: 'computed_recently' }).ok).toBe(
      false,
    );
    expect(readSecurityAlertBaseline({ ...computed, buckets: 'many' }).ok).toBe(false);
  });

  it('the counts the claim takes, and nothing else', () => {
    expect(
      isAlertCounts({
        events: 12,
        at_least: true,
        kind: 'sign_in_not_me',
        list: [1, 'a'],
        by_country: { US: 3, other: 1 },
      }),
    ).toBe(true);
    for (const bad of [
      { Events: 1 },
      { events: -1 },
      { events: 1.5 },
      { events: 99_999_999_999_999 },
      { address: '192.0.2.1' },
      { who: 'person@example.test' },
      { id: '0a0a0a0a-0000-4000-8000-00000000000a' },
      { list: [{}] },
      { by: { 'not a word': 1 } },
      { n: null },
      [],
      'events',
    ]) {
      expect(isAlertCounts(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

/* ─────────────────────────────────────── the rules ─────────────────────────────────────── */

const cells = (starts: number[], events: number) =>
  Object.fromEntries(starts.map((s) => [s, events]));

describe('serious flags, first', () => {
  it('six cheap alerts do not delay a serious flag', () => {
    // Six volume and record conditions and retries, and one serious flag at the end of the read.
    const p = plan({
      aimed: [ORG_A, ORG_B].map((org) => ({ org, cells: cells(LAST3, 30) })),
      buckets: { [JUDGED]: { troubleRows: 5, events: 900, sources: 80 } },
      retry: [
        { rule: 'spike', key: key(JUDGED - 6 * BUCKET), phase: 'started' },
        { rule: 'alerts_held', key: key(JUDGED - 6 * BUCKET), phase: 'started' },
      ],
      serious: [{ reason: 'unrecorded_server_form_password', hour: Date.UTC(2026, 10, 24, 11) }],
      seriousRetry: ['sign_in_not_me|2026-11-24T10:00Z'],
    });
    const order = securityAlertClaimOrder(p);
    expect(order.length).toBeGreaterThanOrEqual(8);
    expect(order.slice(0, 2).map((c) => c.rule)).toEqual(['serious_flag', 'serious_flag']);
    expect(order.slice(2).every((c) => c.rule !== 'serious_flag')).toBe(true);
    // The retry of a serious flag comes before the new ones.
    expect(order[0]!.eventKey).toBe('sign_in_not_me|2026-11-24T10:00Z');
  });

  it("a serious flag is claimed with the inputs' key and its counts; its retry with none", () => {
    const hour = Date.UTC(2026, 10, 24, 9);
    const p = plan({
      serious: [{ reason: 'passkey_counter_went_back', hour, events: 2 }],
      seriousRetry: ['sign_in_not_me|2026-11-24T08:00Z'],
    });
    expect(p.serious).toEqual([
      {
        rule: 'serious_flag',
        subject: '',
        eventKey: 'passkey_counter_went_back|2026-11-24T09:00Z',
        phase: 'started',
        counts: { events: 2, at_least: false, tally: false, flagged_in_flood: false },
      },
    ]);
    expect(p.seriousRetries[0]!.counts).toBeNull();
  });

  it('a flagged flood row is a serious flag, keyed by its flood reason', () => {
    const p = plan({
      serious: [{ reason: 'over_buffer_cap', hour: Date.UTC(2026, 10, 24, 11), flood: true }],
    });
    expect(p.serious[0]!.eventKey).toBe('over_buffer_cap|2026-11-24T11:00Z');
    expect(p.serious[0]!.counts).toMatchObject({ flagged_in_flood: true });
  });

  it('a partial read still claims every serious flag and every retry', () => {
    const p = plan({
      shortenedFrom: binOf(NOW - 2 * HOUR) + 3 * MIN,
      truncated: { aimed: true, open: true, seriousRetry: true, retry: true },
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 11) }],
      seriousRetry: ['sign_in_not_me|2026-11-24T10:00Z'],
    });
    expect(p.partial).toBe(true);
    expect(p.serious).toHaveLength(1);
    expect(p.seriousRetries).toHaveLength(1);
    expect(p.shortenedFrom).not.toBeNull();
  });
});

describe('guessing aimed at one organization', () => {
  it('20 events in the 30 minutes of whole buckets that end with the judged one: a start keyed by that bucket', () => {
    const p = plan({ aimed: [{ org: ORG_A, cells: cells(LAST3, 7) }] });
    expect(p.conditions).toEqual([
      {
        rule: 'aimed_guessing',
        subject: ORG_A,
        eventKey: key(JUDGED),
        phase: 'started',
        counts: { events: 21, minutes: 30 },
      },
    ]);
  });

  it('19 is not 20; events in the bucket running now and older than the window do not count', () => {
    expect(
      plan({ aimed: [{ org: ORG_A, cells: { [LAST3[0]!]: 6, [LAST3[1]!]: 6, [LAST3[2]!]: 7 } }] })
        .conditions,
    ).toEqual([]);
    // 14 in the window, 10 in the bucket running now, 10 just before the window.
    expect(
      plan({
        aimed: [
          { org: ORG_A, cells: { [JUDGED + BUCKET]: 10, [JUDGED - 3 * BUCKET]: 10, [JUDGED]: 14 } },
        ],
      }).conditions,
    ).toEqual([]);
  });

  it('the threshold and the minutes are the live ones', () => {
    const p = plan({
      aimed: [{ org: ORG_A, cells: cells([JUDGED - 5 * BUCKET, JUDGED], 5) }],
      thresholds: { aimed_guessing_events: 10, aimed_guessing_minutes: 60 },
    });
    expect(p.conditions.map((c) => [c.phase, c.counts])).toEqual([
      ['started', { events: 10, minutes: 60 }],
    ]);
  });

  it('each organization is its own state, the busiest first', () => {
    const p = plan({
      aimed: [
        { org: ORG_B, cells: cells(LAST3, 40) },
        { org: ORG_A, cells: cells(LAST3, 10) },
      ],
    });
    expect(p.conditions.map((c) => c.subject)).toEqual([ORG_B, ORG_A]);
  });
});

describe('the spike', () => {
  const spiky = { [JUDGED]: { events: 51, sources: 10 } };

  it('is HELD with no baseline, and while the record is younger than the learning days: nothing claimed', () => {
    const noBaseline = inputs({
      buckets: spiky,
      baseline: { eventHigh: null, sourceHigh: null, computedAt: null },
    });
    expect(securityAlertSpikeHeld(noBaseline)).toBe('no_baseline');
    expect(planSecurityAlerts(noBaseline).conditions).toEqual([]);
    const young = inputs({ buckets: spiky, oldest: NOW - 13 * DAY });
    expect(securityAlertSpikeHeld(young)).toBe('learning');
    expect(planSecurityAlerts(young).conditions).toEqual([]);
    expect(securityAlertSpikeHeld(inputs({ buckets: spiky, oldest: null }))).toBe('learning');
    // An open spike state is not ended while the rule is held either.
    expect(
      plan({
        oldest: NOW - 13 * DAY,
        openStates: [{ rule: 'spike', key: key(JUDGED - 9 * BUCKET) }],
      }).conditions,
    ).toEqual([]);
  });

  it('judged once the record is 14 days old: more events than the mark, from at least the source mark', () => {
    const p = plan({ buckets: spiky, oldest: NOW - 14 * DAY });
    expect(p.spikeHeld).toBeNull();
    expect(p.conditions).toEqual([
      {
        rule: 'spike',
        subject: '',
        eventKey: key(JUDGED),
        phase: 'started',
        counts: { events: 51, sources: 10, event_mark: 50, source_mark: 10 },
      },
    ]);
    // At the mark is not past it; one source short is not enough.
    expect(plan({ buckets: { [JUDGED]: { events: 50, sources: 10 } } }).conditions).toEqual([]);
    expect(plan({ buckets: { [JUDGED]: { events: 500, sources: 9 } } }).conditions).toEqual([]);
  });

  it('the stored high mark above the floor is the mark', () => {
    const baseline = { eventHigh: 400, sourceHigh: 25, computedAt: NOW - HOUR };
    expect(
      plan({ baseline, buckets: { [JUDGED]: { events: 400, sources: 30 } } }).conditions,
    ).toEqual([]);
    expect(
      plan({ baseline, buckets: { [JUDGED]: { events: 401, sources: 24 } } }).conditions,
    ).toEqual([]);
    expect(
      plan({ baseline, buckets: { [JUDGED]: { events: 401, sources: 25 } } }).conditions,
    ).toHaveLength(1);
  });

  it('the learning days are the live ones', () => {
    expect(
      securityAlertSpikeHeld(
        inputs({ buckets: spiky, oldest: NOW - 20 * DAY, thresholds: { spike_learning_days: 30 } }),
      ),
    ).toBe('learning');
    const judged = inputs({
      buckets: spiky,
      oldest: NOW - 10 * DAY,
      thresholds: { spike_learning_days: 7 },
    });
    expect(securityAlertSpikeHeld(judged)).toBeNull();
    expect(planSecurityAlerts(judged).conditions.map((c) => c.rule)).toEqual(['spike']);
  });

  it('the bucket running now is never judged', () => {
    expect(
      plan({ buckets: { [JUDGED + BUCKET]: { events: 5000, sources: 500 } } }).conditions,
    ).toEqual([]);
  });
});

describe('record trouble', () => {
  it('a flood row of the record in the judged bucket starts it; the threshold is the live one', () => {
    expect(plan({ buckets: { [JUDGED]: { troubleRows: 1 } } }).conditions).toEqual([
      {
        rule: 'record_trouble',
        subject: '',
        eventKey: key(JUDGED),
        phase: 'started',
        counts: { rows: 1, events: 7 },
      },
    ]);
    expect(
      plan({ buckets: { [JUDGED]: { troubleRows: 2 } }, thresholds: { record_trouble_rows: 3 } })
        .conditions,
    ).toEqual([]);
  });

  it('comes before the spike and the guessing', () => {
    const p = plan({
      buckets: { [JUDGED]: { troubleRows: 1, events: 900, sources: 90 } },
      aimed: [{ org: ORG_A, cells: cells(LAST3, 30) }],
    });
    expect(p.conditions.map((c) => c.rule)).toEqual(['record_trouble', 'spike', 'aimed_guessing']);
  });
});

describe('the state: one start, reminders at 1, 6 and 24 hours, one end', () => {
  const stateKey = (agoMs: number) => key(binOf(NOW - agoMs));

  it('an open state still present claims nothing until a reminder is due', () => {
    const p = plan({
      aimed: [{ org: ORG_A, cells: cells(LAST3, 30) }],
      openStates: [{ rule: 'aimed_guessing', subject: ORG_A, key: stateKey(30 * MIN) }],
    });
    expect(p.conditions).toEqual([]);
  });

  it('the 1-hour reminder is due when its key and step have passed, give or take the minute', () => {
    // The state's key is 11:00; the read's now is 12:05:30: 1 hour has passed.
    const k = key(Date.UTC(2026, 10, 24, 11));
    const p = plan({
      aimed: [{ org: ORG_A, cells: cells(LAST3, 30) }],
      openStates: [{ rule: 'aimed_guessing', subject: ORG_A, key: k }],
    });
    expect(p.conditions).toEqual([
      {
        rule: 'aimed_guessing',
        subject: ORG_A,
        eventKey: `${k}+1h`,
        phase: 'reminder',
        counts: { events: 90, minutes: 30 },
      },
    ]);
    expect(dueReminderStep('2026-11-24T11:00Z', Date.UTC(2026, 10, 24, 11, 59), [])).toBe('1h');
    expect(dueReminderStep('2026-11-24T11:00Z', Date.UTC(2026, 10, 24, 11, 58, 59), [])).toBeNull();
    expect(dueReminderStep('2026-11-24T11:00Z', NOW, ['1h'])).toBeNull();
  });

  it('never two reminders in one run: after a gap, only the latest step that is due', () => {
    const k = key(Date.UTC(2026, 10, 24, 5));
    expect(dueReminderStep(k, NOW, [])).toBe('6h');
    expect(dueReminderStep(k, NOW, ['6h'])).toBeNull();
    expect(dueReminderStep(k, NOW + 20 * HOUR, ['1h', '6h'])).toBe('24h');
    expect(dueReminderStep(k, NOW + 40 * HOUR, ['1h', '6h', '24h'])).toBeNull();
  });

  it('an end only after 30 quiet minutes: quiet for 20 keeps it open (and its reminders due)', () => {
    const k = key(Date.UTC(2026, 10, 24, 11));
    const twentyQuiet = plan({
      buckets: { [JUDGED - 2 * BUCKET]: { troubleRows: 1 } },
      openStates: [{ rule: 'record_trouble', key: k }],
    });
    expect(twentyQuiet.conditions.map((c) => c.phase)).toEqual(['reminder']);
    const thirtyQuiet = plan({
      buckets: { [JUDGED - 3 * BUCKET]: { troubleRows: 1 } },
      openStates: [{ rule: 'record_trouble', key: k }],
    });
    expect(thirtyQuiet.conditions).toEqual([
      {
        rule: 'record_trouble',
        subject: '',
        eventKey: k,
        phase: 'ended',
        counts: { rows: 0, events: 0 },
      },
    ]);
  });

  it('an open state of an organization the read no longer lists ends (a whole read)', () => {
    const p = plan({
      openStates: [{ rule: 'aimed_guessing', subject: ORG_B, key: stateKey(2 * HOUR) }],
    });
    expect(p.conditions).toEqual([
      {
        rule: 'aimed_guessing',
        subject: ORG_B,
        eventKey: stateKey(2 * HOUR),
        phase: 'ended',
        counts: { quiet_minutes: 30 },
      },
    ]);
  });

  it.each([
    ['shortened', { shortenedFrom: binOf(NOW - 3 * HOUR) + 3 * MIN }],
    ['aimed_truncated', { truncated: { aimed: true } }],
    ['open_states_truncated', { truncated: { open: true } }],
    ['serious_retry_due_truncated', { truncated: { seriousRetry: true } }],
    ['retry_due_truncated', { truncated: { retry: true } }],
  ] as const)(
    'never an end from a partial read (%s): the condition may only be out of sight',
    (_what, partial) => {
      const p = plan({
        ...partial,
        openStates: [
          { rule: 'aimed_guessing', subject: ORG_B, key: stateKey(2 * HOUR) },
          { rule: 'record_trouble', key: stateKey(2 * HOUR) },
        ],
      });
      expect(p.partial).toBe(true);
      expect(p.conditions.filter((c) => c.phase === 'ended')).toEqual([]);
    },
  );

  it('a partial read still starts a condition it sees', () => {
    const p = plan({
      truncated: { aimed: true },
      aimed: [{ org: ORG_A, cells: cells(LAST3, 30) }],
    });
    expect(p.conditions.map((c) => c.phase)).toEqual(['started']);
  });

  it('a state_ended start is claimed again only with a newer judged bucket, never with the refused key', () => {
    expect(nextStartKey('2026-11-24T11:40Z', '2026-11-24T11:50Z')).toBe('2026-11-24T11:50Z');
    expect(nextStartKey('2026-11-24T11:50Z', '2026-11-24T11:50Z')).toBeNull();
    expect(nextStartKey('2026-11-24T11:50Z', '2026-11-24T11:40Z')).toBeNull();
    expect(nextStartKey('2026-11-24T11:50Z', null)).toBeNull();
  });

  /**
   * A model of the database's states (one open per rule and subject, its
   * reminders, an end closes it), run every 10 minutes over the hours given.
   * Answers every claim the plans made.
   */
  function simulate(hours: number, guessingAt: (bucketStart: number) => number, start = NOW) {
    const claims: AlertClaimAsk[] = [];
    let open: { key: string; reminders: string[] } | null = null;
    for (let t = start; t <= start + hours * HOUR; t += BUCKET) {
      const judged = binOf(t) - BUCKET;
      const cellsNow: Record<number, number> = {};
      for (let b = binOf(t - 8 * HOUR) + BUCKET; b <= binOf(t); b += BUCKET) {
        const n = guessingAt(b);
        if (n > 0) cellsNow[b] = n;
      }
      const p: SecurityAlertPlan = planSecurityAlerts(
        inputs({
          now: t,
          aimed: Object.keys(cellsNow).length > 0 ? [{ org: ORG_A, cells: cellsNow }] : [],
          openStates: open
            ? [{ rule: 'aimed_guessing', subject: ORG_A, key: open.key, reminders: open.reminders }]
            : [],
        }),
      );
      expect(p.judgedBucketKey).toBe(key(judged));
      for (const c of p.conditions) {
        claims.push(c);
        if (c.phase === 'started') open = { key: c.eventKey, reminders: [] };
        else if (c.phase === 'reminder')
          open!.reminders.push(parseAlertReminderKey(c.eventKey)!.step);
        else open = null;
      }
    }
    return claims;
  }
  const couldPush = (claims: AlertClaimAsk[]) => claims.filter((c) => c.phase !== 'ended');

  it('a scan that lasts 12 hours claims at most 4 pushes', () => {
    const scanStart = binOf(NOW);
    const claims = simulate(14, (b) => (b >= scanStart && b < scanStart + 12 * HOUR ? 25 : 0));
    expect(couldPush(claims).length).toBeLessThanOrEqual(4);
    expect(claims.map((c) => c.phase)).toEqual(['started', 'reminder', 'reminder', 'ended']);
  });

  it('a scan that lasts 12 hours and pauses for 20 minutes every hour is still one state', () => {
    const scanStart = binOf(NOW);
    const claims = simulate(14, (b) => {
      if (b < scanStart || b >= scanStart + 12 * HOUR) return 0;
      // Two quiet buckets in every six.
      return Math.floor((b - scanStart) / BUCKET) % 6 >= 4 ? 0 : 25;
    });
    expect(couldPush(claims).length).toBeLessThanOrEqual(4);
    expect(claims.filter((c) => c.phase === 'started')).toHaveLength(1);
  });

  it('a scan that lasts a day and a half claims its start and three reminders, the last at 24 hours', () => {
    const scanStart = binOf(NOW);
    const claims = simulate(40, (b) => (b >= scanStart && b < scanStart + 36 * HOUR ? 25 : 0));
    expect(claims.map((c) => c.eventKey.slice(-4))).toEqual([
      claims[0]!.eventKey.slice(-4),
      'Z+1h',
      'Z+6h',
      '+24h',
      claims[0]!.eventKey.slice(-4),
    ]);
    expect(couldPush(claims)).toHaveLength(4);
  });
});

/* ───────────────────────── a lost run never loses an alert (S1) ───────────────────────── */

/**
 * The claim's one-row rule, as 0480 answers it (CONTRACT.md, the claim): one
 * row per rule, subject, key and phase (a repeat is a duplicate); one open
 * state per rule and subject (already_open names it); a start with the key
 * of a state that ended is state_ended; a reminder only once its step has
 * passed; a new start key no older than the 8-hour window.
 */
class ClaimModel {
  rows: string[] = [];
  private seen = new Set<string>();
  states: Array<{
    rule: string;
    subject: string;
    key: string;
    reminders: string[];
    ended: boolean;
  }> = [];
  openStates() {
    return this.states
      .filter((s) => !s.ended)
      .map((s) => ({ rule: s.rule, subject: s.subject, key: s.key, reminders: [...s.reminders] }));
  }
  claim(
    ask: AlertClaimAsk,
    nowMs: number,
  ): { outcome: 'new' | 'duplicate' | 'refused'; refused?: string; openKey?: string } {
    const row = `${ask.rule} ${ask.phase} ${ask.eventKey}`;
    const same = (s: { rule: string; subject: string }) =>
      s.rule === ask.rule && s.subject === ask.subject;
    const add = () => {
      this.seen.add(`${ask.subject}|${row}`);
      this.rows.push(row);
      return { outcome: 'new' as const };
    };
    if (this.seen.has(`${ask.subject}|${row}`)) {
      const ended = this.states.find((s) => same(s) && s.key === ask.eventKey && s.ended);
      return ask.phase === 'started' && ended
        ? { outcome: 'refused', refused: 'state_ended' }
        : { outcome: 'duplicate' };
    }
    if (ask.phase === 'started') {
      const open = this.states.find((s) => same(s) && !s.ended);
      if (open) return { outcome: 'refused', refused: 'already_open', openKey: open.key };
      const at = alertBucketKeyMs(ask.eventKey)!;
      if (at < nowMs - 8 * HOUR || at > nowMs)
        return { outcome: 'refused', refused: 'key_out_of_window' };
      this.states.push({
        rule: ask.rule,
        subject: ask.subject,
        key: ask.eventKey,
        reminders: [],
        ended: false,
      });
      return add();
    }
    const base = ask.phase === 'reminder' ? parseAlertReminderKey(ask.eventKey)! : null;
    const state = this.states.find(
      (s) => same(s) && s.key === (base ? base.stateKey : ask.eventKey),
    );
    if (!state) return { outcome: 'refused', refused: 'no_open_state' };
    if (state.ended) return { outcome: 'refused', refused: 'state_ended' };
    if (base) {
      const step = { '1h': HOUR, '6h': 6 * HOUR, '24h': DAY }[base.step];
      if (base.stateMs + step > nowMs + MIN)
        return { outcome: 'refused', refused: 'reminder_not_due' };
      state.reminders.push(base.step);
    } else {
      state.ended = true;
    }
    return add();
  }
}

type Rule3 = 'record_trouble' | 'spike' | 'aimed_guessing';

/**
 * The job every 10 minutes from NOW over `hours`, against the claim model,
 * claiming as the job does (a start answered already_open takes its due
 * reminder; state_ended is claimed again only with a newer judged bucket).
 * `size(b)`: the condition's size in the whole bucket that starts at b.
 * `lost(i)`: run i never happened (failed, missed, or cut before its claims).
 * `twice(i)`: run i overlapped another that read the same answer.
 */
function everyTenMinutes(o: {
  rule: Rule3;
  hours: number;
  size: (bucketStart: number) => number;
  lost?: (run: number) => boolean;
  twice?: (run: number) => boolean;
}) {
  const db = new ClaimModel();
  const answered: string[] = [];
  const ends: string[] = [];
  for (let i = 0, t = NOW; t <= NOW + o.hours * HOUR; i += 1, t += BUCKET) {
    if (o.lost?.(i)) continue;
    const buckets: NonNullable<RawOptions['buckets']> = {};
    const aimedCells: Record<number, number> = {};
    for (let b = binOf(t - 8 * HOUR) + BUCKET; b <= binOf(t); b += BUCKET) {
      const n = o.size(b);
      if (n <= 0) continue;
      if (o.rule === 'record_trouble') buckets[b] = { troubleRows: n };
      else if (o.rule === 'spike') buckets[b] = { events: n, sources: n };
      else aimedCells[b] = n;
    }
    const read = inputs({
      now: t,
      buckets,
      aimed: Object.keys(aimedCells).length > 0 ? [{ org: ORG_A, cells: aimedCells }] : [],
      openStates: db.openStates(),
    });
    // Both overlapping runs read before either claims.
    const plans = Array.from({ length: o.twice?.(i) ? 2 : 1 }, () => planSecurityAlerts(read));
    for (const p of plans) {
      for (const ask of p.conditions) {
        const a = db.claim(ask, t);
        answered.push(a.outcome === 'refused' ? `refused ${a.refused}` : a.outcome);
        if (a.outcome === 'new' && ask.phase === 'ended') ends.push(p.judgedBucketKey!);
        if (a.refused === 'already_open' && a.openKey) {
          const step = dueReminderStep(a.openKey, read.nowMs, []);
          if (step !== null) {
            const r = db.claim(
              { ...ask, eventKey: alertReminderKey(a.openKey, step), phase: 'reminder' },
              t,
            );
            answered.push(r.outcome === 'refused' ? `refused ${r.refused}` : r.outcome);
          }
        } else if (a.refused === 'state_ended') {
          const newer = nextStartKey(ask.eventKey, p.judgedBucketKey);
          if (newer !== null) answered.push(db.claim({ ...ask, eventKey: newer }, t).outcome);
        }
      }
    }
  }
  return { rows: db.rows, answered, ends };
}

describe('a lost run never loses an alert: every run judges the last three whole buckets', () => {
  /** The bucket the bursts below fall in: 12:20; the first run that judges it whole is at 12:35:30 (run 3). */
  const B = binOf(NOW) + 2 * BUCKET;
  const FIRST_JUDGE = 3;
  const BIG: Record<Rule3, number> = { record_trouble: 40, spike: 90_000, aimed_guessing: 5_000 };
  /** The last whole bucket at which a one-bucket burst at B still holds: aimed guessing counts 30 minutes. */
  const LAST_HELD: Record<Rule3, number> = {
    record_trouble: B,
    spike: B,
    aimed_guessing: B + 2 * BUCKET,
  };
  const RULES: Rule3[] = ['record_trouble', 'spike', 'aimed_guessing'];

  it('a burst in the bucket before the judged one still starts its state, keyed by its own bucket', () => {
    expect(plan({ buckets: { [JUDGED - BUCKET]: { troubleRows: 40 } } }).conditions).toEqual([
      {
        rule: 'record_trouble',
        subject: '',
        eventKey: key(JUDGED - BUCKET),
        phase: 'started',
        counts: { rows: 40, events: 280 },
      },
    ]);
    expect(
      plan({ buckets: { [JUDGED - BUCKET]: { events: 90_000, sources: 4_000 } } }).conditions,
    ).toEqual([
      {
        rule: 'spike',
        subject: '',
        eventKey: key(JUDGED - BUCKET),
        phase: 'started',
        counts: { events: 90_000, sources: 4_000, event_mark: 50, source_mark: 10 },
      },
    ]);
    // Guessing two buckets back: the window that ends there already holds it.
    expect(
      plan({ aimed: [{ org: ORG_A, cells: { [JUDGED - 2 * BUCKET]: 5_000 } }] }).conditions,
    ).toEqual([
      {
        rule: 'aimed_guessing',
        subject: ORG_A,
        eventKey: key(JUDGED - 2 * BUCKET),
        phase: 'started',
        counts: { events: 5_000, minutes: 30 },
      },
    ]);
  });

  it('the oldest bucket of the look-back where it holds gives the key and its counts', () => {
    const p = plan({
      buckets: { [JUDGED - 2 * BUCKET]: { troubleRows: 1 }, [JUDGED]: { troubleRows: 9 } },
    });
    expect(p.conditions).toEqual([
      {
        rule: 'record_trouble',
        subject: '',
        eventKey: key(JUDGED - 2 * BUCKET),
        phase: 'started',
        counts: { rows: 1, events: 7 },
      },
    ]);
    // Guessing that crossed its line in the window ending one bucket back is keyed there.
    expect(
      plan({ aimed: [{ org: ORG_A, cells: cells(LAST3, 10) }] }).conditions.map((c) => c.eventKey),
    ).toEqual([key(JUDGED - BUCKET)]);
  });

  it('the look-back is the three whole buckets an end needs, no more: an older burst starts nothing', () => {
    expect(plan({ buckets: { [JUDGED - 3 * BUCKET]: { troubleRows: 40 } } }).conditions).toEqual(
      [],
    );
    expect(
      plan({ buckets: { [JUDGED - 3 * BUCKET]: { events: 90_000, sources: 4_000 } } }).conditions,
    ).toEqual([]);
    expect(
      plan({ aimed: [{ org: ORG_A, cells: { [JUDGED - 5 * BUCKET]: 5_000 } }] }).conditions,
    ).toEqual([]);
  });

  it('no end from a read that holds fewer whole buckets than an end needs quiet', () => {
    const raw = rawInputs({
      openStates: [{ rule: 'record_trouble', key: key(JUDGED - 9 * BUCKET) }],
    });
    // The bucket running now and two whole ones: an end needs three.
    const short = { ...raw, buckets: (raw.buckets as unknown[]).slice(-3) };
    const read = readSecurityAlertInputs(short);
    if (!read.ok || read.value === null) throw new Error('fixture unreadable');
    const p = planSecurityAlerts(read.value);
    expect(p.partial).toBe(false);
    expect(p.conditions).toEqual([]);
    expect(
      plan({
        openStates: [{ rule: 'record_trouble', key: key(JUDGED - 9 * BUCKET) }],
      }).conditions.map((c) => c.phase),
    ).toEqual(['ended']);
  });

  it.each(RULES)(
    '%s: a one-bucket burst is claimed once with every run, and once under the same key with the run that first judges it lost',
    (rule) => {
      const size = (b: number) => (b === B ? BIG[rule] : 0);
      const all = everyTenMinutes({ rule, hours: 10, size });
      expect(all.rows).toEqual([`${rule} started ${key(B)}`, `${rule} ended ${key(B)}`]);
      // Nothing is claimed twice: every ask of every run was new.
      expect(all.answered.every((a) => a === 'new')).toBe(true);
      // The end only after three quiet whole buckets.
      expect(all.ends).toEqual([key(LAST_HELD[rule] + 3 * BUCKET)]);
      for (const lost of [
        (i: number) => i === FIRST_JUDGE,
        (i: number) => i === FIRST_JUDGE || i === FIRST_JUDGE + 1,
        (i: number) => i % 3 === 0,
      ]) {
        const some = everyTenMinutes({ rule, hours: 10, size, lost });
        expect(some.rows).toEqual(all.rows);
        expect(some.answered.every((a) => a === 'new')).toBe(true);
      }
    },
  );

  it.each(RULES)(
    '%s: a condition that lasts 26 hours, with the middle run of every three lost: one start, 1 h, 6 h, 24 h, one end, each once and under the same keys',
    (rule) => {
      const size = (b: number) =>
        b >= B && b < B + 26 * HOUR
          ? Math.ceil(BIG[rule] / (rule === 'aimed_guessing' ? 100 : 1))
          : 0;
      const all = everyTenMinutes({ rule, hours: 30, size });
      expect(all.rows).toEqual([
        `${rule} started ${key(B)}`,
        `${rule} reminder ${key(B)}+1h`,
        `${rule} reminder ${key(B)}+6h`,
        `${rule} reminder ${key(B)}+24h`,
        `${rule} ended ${key(B)}`,
      ]);
      expect(all.answered.every((a) => a === 'new')).toBe(true);
      const middle = everyTenMinutes({ rule, hours: 30, size, lost: (i) => i % 3 === 1 });
      expect(middle.rows).toEqual(all.rows);
      expect(middle.answered.every((a) => a === 'new')).toBe(true);
    },
  );

  it.each(RULES)(
    '%s: two runs that read the same answer claim each alert once: the repeat is a duplicate, one row',
    (rule) => {
      const size = (b: number) => (b >= B && b < B + 7 * HOUR ? BIG[rule] : 0);
      const once = everyTenMinutes({ rule, hours: 9, size });
      const twice = everyTenMinutes({ rule, hours: 9, size, twice: () => true });
      expect(twice.rows).toEqual(once.rows);
      expect(once.rows).toHaveLength(4);
      expect(twice.answered.filter((a) => a === 'new')).toHaveLength(4);
      expect(twice.answered.filter((a) => a !== 'new').every((a) => a === 'duplicate')).toBe(true);
    },
  );
});

/* ─────────────────────────────────────── record only ─────────────────────────────────────── */

describe('record only (4a): what a channel handed out records', () => {
  it('skipped for every recipient, 0 to 100', () => {
    expect(recordOnlyResult(2)).toEqual({ skipped: 2 });
    expect(recordOnlyResult(0)).toEqual({ skipped: 0 });
    expect(recordOnlyResult(-3)).toEqual({ skipped: 0 });
    expect(recordOnlyResult(Number.NaN)).toEqual({ skipped: 0 });
    expect(recordOnlyResult(500)).toEqual({ skipped: 100 });
  });
});

/* ─────────────────────────────────────── the console ─────────────────────────────────────── */

function row(over: Partial<SecurityAlertRow> = {}): SecurityAlertRow {
  return {
    rule: 'aimed_guessing',
    class: 'volume',
    subject: ORG_A,
    organizationName: 'Example School A',
    eventKey: '2026-11-24T11:50Z',
    phase: 'started',
    counts: { events: 21, minutes: 30 },
    disposition: 'record_only',
    pushPlanned: false,
    emailPlanned: false,
    pushCounted: true,
    emailFloor: null,
    pushResult: null,
    emailResult: null,
    attempts: 1,
    claimedAt: pg(NOW),
    resultedAt: null,
    stateEndedAt: null,
    awaitingResult: false,
    overdue: false,
    ...over,
  };
}

/** A sentence that says something went out. "would have been sent" and "Not sent" are not that. */
const CLAIMS_SENT =
  /\b(?:was|were|is|are|has been|have been|got) (?:sent|delivered)\b|^Sent\b|\bwent out\b/i;
const claimsSent = (text: string) =>
  CLAIMS_SENT.test(text.replace(/would have been sent/gi, '').replace(/would have gone/gi, ''));

describe('the words of one alert', () => {
  it('every disposition in plain words', () => {
    for (const d of ALERT_DISPOSITIONS)
      expect(securityAlertDispositionWords(d).length).toBeGreaterThan(10);
    expect(securityAlertDispositionWords('record_only')).toMatch(/^Recorded only/);
    expect(securityAlertDispositionWords('held_for_summary')).toMatch(/not built yet/);
  });

  it('recorded only, a free push slot: it would have pushed; email depends on a cap that is not counted', () => {
    expect(securityAlertSendingLines(row())).toEqual([
      'Recorded only: no alert channel was on, so nothing was handed out to be sent.',
      'With push on: a push (a slot of its budget was free).',
      "With email on: an email, unless the day's email cap for its kind was reached. That cap is not counted while email is off.",
    ]);
  });

  it('recorded only, a serious flag with no push slot: by email, even with email alerts off', () => {
    const lines = securityAlertSendingLines(
      row({
        rule: 'serious_flag',
        class: 'serious',
        subject: '',
        organizationName: null,
        eventKey: 'sign_in_not_me|2026-11-24T11:00Z',
        pushCounted: false,
      }),
    );
    expect(lines[1]).toMatch(/would have gone by email, even with email alerts off/);
    expect(lines[2]).toMatch(/never capped or held/);
  });

  it('recorded only, an end: never a push', () => {
    expect(securityAlertSendingLines(row({ phase: 'ended', pushCounted: false }))[1]).toBe(
      'With push on: no push (an end never pushes).',
    );
  });

  it("the email floor in the coordinator's words", () => {
    const spent = securityAlertSendingLines(
      row({
        rule: 'serious_flag',
        class: 'serious',
        subject: '',
        eventKey: 'sign_in_not_me|2026-11-24T11:00Z',
        disposition: 'email_only_budget',
        emailPlanned: true,
        emailFloor: 'push_budget_spent',
        emailResult: { skipped: 2 },
        resultedAt: pg(NOW),
      }),
    );
    expect(spent).toContain(
      'Would have gone by email although email alerts are off, because the push budget was spent.',
    );
    expect(spent).toContain('Email: 2 skipped (this release sends nothing)');
    const failed = securityAlertSendingLines(
      row({
        rule: 'serious_flag',
        class: 'serious',
        subject: '',
        eventKey: 'sign_in_not_me|2026-11-24T11:00Z',
        disposition: 'sent',
        pushPlanned: true,
        emailPlanned: true,
        emailFloor: 'push_failed',
        pushResult: { skipped: 2 },
        emailResult: { skipped: 2 },
        resultedAt: pg(NOW),
      }),
    );
    expect(failed).toContain('Its push reached no one, so its email would have gone in its place.');
  });

  it('the held notice says it would have been sent, with the count only', () => {
    const lines = securityAlertSendingLines(
      row({
        rule: 'alerts_held',
        class: 'notice',
        subject: '',
        organizationName: null,
        eventKey: '2026-11-24T12:00Z',
        disposition: 'sent',
        emailPlanned: true,
        counts: { held: 3 },
      }),
    );
    expect(lines).toContain(
      'An "alerts are being held" notice would have been sent: 3 alerts were held in the last 24 hours.',
    );
  });

  it('no line claims that anything was sent, for any alert this release can record', () => {
    const rows: SecurityAlertRow[] = [];
    for (const disposition of ALERT_DISPOSITIONS) {
      for (const rule of [
        'serious_flag',
        'aimed_guessing',
        'spike',
        'record_trouble',
        'alerts_held',
      ] as const) {
        for (const pushCounted of [true, false]) {
          rows.push(
            row({
              rule,
              class: ALERT_RULES[rule],
              subject: rule === 'aimed_guessing' ? ORG_A : '',
              eventKey:
                rule === 'serious_flag' ? 'sign_in_not_me|2026-11-24T11:00Z' : '2026-11-24T11:50Z',
              disposition,
              pushCounted,
              pushPlanned: disposition === 'sent' || disposition === 'not_sent',
              emailPlanned:
                disposition !== 'record_only' && disposition.startsWith('held') === false,
              pushResult: disposition === 'sent' ? { skipped: 1 } : null,
              emailFloor:
                rule === 'serious_flag' && disposition === 'email_only_budget'
                  ? 'push_budget_spent'
                  : null,
              counts: rule === 'alerts_held' ? { held: 2 } : { events: 3 },
            }),
          );
        }
      }
    }
    for (const r of rows) {
      for (const line of securityAlertSendingLines(r)) expect(claimsSent(line), line).toBe(false);
    }
    // The check itself sees a claim.
    expect(claimsSent('The alert was sent by push.')).toBe(true);
    expect(claimsSent('Sent to 2 admins')).toBe(true);
  });

  it('what, phase, counts, card', () => {
    expect(
      securityAlertWhat(
        row({ rule: 'serious_flag', eventKey: 'sign_in_not_me|2026-11-24T11:00Z' }),
      ),
    ).toBe('A member said a sign-in was not them');
    expect(
      securityAlertWhat(
        row({ rule: 'serious_flag', eventKey: 'over_minute_cap|2026-11-24T11:00Z' }),
      ),
    ).toMatch(/flagged during a flood/);
    expect(
      securityAlertPhaseLabel(row({ phase: 'reminder', eventKey: '2026-11-24T11:50Z+6h' })),
    ).toBe('Reminder: 6 hours on');
    expect(
      securityAlertCountsWords({ events: 1200, sources: 3, at_least: true, tally: false }),
    ).toBe('1,200 events · 3 sources · at least (a floor)');
    expect(securityAlertCountsWords({})).toBe('—');
    expect(
      securityAlertCardId(
        row({ rule: 'serious_flag', eventKey: 'sign_in_not_me|2026-11-24T11:00Z' }),
      ),
    ).toBe('sign-in-not-me');
    expect(
      securityAlertCardId(
        row({ rule: 'serious_flag', eventKey: 'over_buffer_cap|2026-11-24T11:00Z' }),
      ),
    ).toBe('counts-past-limit');
    expect(securityAlertCardId(row())).toBe('repeated-wrong-guesses');
    expect(securityAlertCardId(row({ rule: 'record_trouble' }))).toBe('counts-past-limit');
    expect(securityAlertCardId(row({ rule: 'spike' }))).toBeNull();
    expect(securityAlertCardId(row({ rule: 'alerts_held' }))).toBeNull();
  });
});

describe('the thresholds and the changes', () => {
  it('a value that is not its default is marked; the most of a trigger and 0 pushes are warned', () => {
    const rows = securityAlertThresholdRows({
      ...ALERT_THRESHOLD_DEFAULTS,
      aimed_guessing_events: 100000,
      spike_learning_days: 90,
      volume_pushes_per_day: 0,
      serious_pushes_per_hour: 60,
    });
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(rows).toHaveLength(10);
    expect(by.aimed_guessing_events!.differs).toBe(true);
    expect(by.aimed_guessing_events!.warning).toMatch(/never fire/);
    expect(by.spike_learning_days!.warning).toMatch(/never fire/);
    expect(by.volume_pushes_per_day!.warning).toMatch(/no volume or record alert can push/);
    expect(by.serious_pushes_per_hour!.differs).toBe(true);
    expect(by.serious_pushes_per_hour!.warning).toBeNull();
    expect(by.record_trouble_rows!.differs).toBe(false);
  });

  it('every change name has words; values in words', () => {
    for (const name of ALERT_CHANGE_NAMES)
      expect(securityAlertChangeLabel(name).length).toBeGreaterThan(3);
    const f = (iso: string) => `[${iso}]`;
    expect(securityAlertChangeValueWords('email_on', true, f)).toBe('On');
    expect(securityAlertChangeValueWords('push_on', false, f)).toBe('Off');
    expect(securityAlertChangeValueWords('planned_check', null, f)).toBe('None');
    expect(securityAlertChangeValueWords('planned_check', '2026-11-24T12:30:00+00:00', f)).toBe(
      'Until [2026-11-24T12:30:00+00:00]',
    );
    expect(securityAlertChangeValueWords('volume_pushes_per_day', 1200, f)).toBe('1,200');
  });
});

describe("the job's heartbeat, as the page says it", () => {
  const hb = {
    lastRunStartedAt: pg(NOW - 4 * MIN),
    lastRunFinishedAt: pg(NOW - 3 * MIN),
    lastRunOk: true,
    lastRunPartial: false,
    lastOkAt: pg(NOW - 3 * MIN),
    failuresInARow: 0,
    failureReportedAt: null,
  };
  it('a good check: last checked, no warning', () => {
    const say = securityAlertsHeartbeatSay(hb, NOW);
    expect(say.lastChecked).toEqual({ kind: 'at', at: hb.lastOkAt });
    expect(say.warning).toBe(false);
  });
  it('never run; running; failed; partial; missed; failures in a row', () => {
    const never = securityAlertsHeartbeatSay(
      {
        ...hb,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastRunOk: null,
        lastRunPartial: null,
        lastOkAt: null,
      },
      NOW,
    );
    expect(never.lastChecked.kind).toBe('never');
    expect(never.warning).toBe(true);
    const running = securityAlertsHeartbeatSay(
      { ...hb, lastRunStartedAt: pg(NOW - MIN), lastRunFinishedAt: null, lastRunOk: null },
      NOW,
    );
    expect(running.running).not.toBeNull();
    expect(running.lastFailed).toBeNull();
    const stuck = securityAlertsHeartbeatSay(
      { ...hb, lastRunStartedAt: pg(NOW - 5 * MIN), lastRunFinishedAt: null, lastRunOk: null },
      NOW,
    );
    expect(stuck.running).toBeNull();
    expect(stuck.lastFailed).not.toBeNull();
    expect(securityAlertsHeartbeatSay({ ...hb, lastRunOk: false }, NOW).lastFailed).not.toBeNull();
    const partial = securityAlertsHeartbeatSay({ ...hb, lastRunPartial: true }, NOW);
    expect(partial.partial && partial.warning).toBe(true);
    const missed = securityAlertsHeartbeatSay({ ...hb, lastRunStartedAt: pg(NOW - 26 * MIN) }, NOW);
    expect(missed.missed).not.toBeNull();
    expect(
      securityAlertsHeartbeatSay({ ...hb, lastRunStartedAt: pg(NOW - 24 * MIN) }, NOW).missed,
    ).toBeNull();
    const failing = securityAlertsHeartbeatSay(
      { ...hb, failuresInARow: 3, failureReportedAt: pg(NOW - HOUR) },
      NOW,
    );
    expect(failing.failures).toBe(3);
    expect(failing.failureReportedAt).toBe(pg(NOW - HOUR));
  });
});

/** platform_security_alert_list() as the contract shapes it. */
const rawList = () => ({
  refused: null,
  generated_at: pg(NOW),
  state: {
    email_on: false,
    push_on: false,
    summary_on: false,
    record_only: true,
    planned_check_until: null,
    thresholds: { ...ALERT_THRESHOLD_DEFAULTS },
    baseline: {
      event_high: null,
      source_high: null,
      from: null,
      to: null,
      shortened: null,
      computed_at: null,
    },
    heartbeat: {
      last_run_started_at: pg(NOW - 4 * MIN),
      last_run_finished_at: pg(NOW - 3 * MIN),
      last_run_ok: true,
      last_run_partial: false,
      last_ok_at: pg(NOW - 3 * MIN),
      failures_in_a_row: 0,
      failure_reported_at: null,
    },
  },
  budget: {
    serious_pushes_last_hour: 1,
    serious_pushes_last_day_by_reason: { sign_in_not_me: 1 },
    volume_pushes_last_day: 2,
    volume_emails_last_day: 0,
    record_emails_last_day: 0,
  },
  alerts: [
    {
      rule: 'aimed_guessing',
      class: 'volume',
      subject: ORG_A,
      organization_name: 'Example School A',
      event_key: '2026-11-24T11:50Z',
      phase: 'started',
      counts: { events: 21, minutes: 30 },
      disposition: 'record_only',
      push_planned: false,
      email_planned: false,
      push_counted: true,
      email_floor: null,
      push_result: null,
      email_result: null,
      attempts: 1,
      claimed_at: pg(NOW - 3 * MIN),
      resulted_at: null,
      state_ended_at: null,
      awaiting_result: false,
      overdue: false,
    },
  ],
  alerts_truncated: false,
  changes: [
    {
      changed_at: pg(NOW - DAY),
      actor_user_id: '44444444-4444-4444-8444-444444444444',
      name: 'planned_check',
      old_value: null,
      new_value: pg(NOW - DAY + 30 * MIN),
    },
  ],
  changes_truncated: false,
  latest_changes: [],
});

describe('the list reader', () => {
  const list = rawList;

  it('reads it, and its refusal', () => {
    const read = readSecurityAlertList(list());
    expect(read.ok && read.value?.alerts[0]?.organizationName).toBe('Example School A');
    expect(readSecurityAlertList({ refused: 'no_state', generated_at: pg(NOW) })).toEqual({
      ok: true,
      value: null,
      refused: 'no_state',
    });
  });

  it.each([
    [
      'record_only that the switches do not say',
      (l: ReturnType<typeof list>) => ({ ...l, state: { ...l.state, record_only: false } }),
    ],
    [
      'counts with an address',
      (l: ReturnType<typeof list>) => ({
        ...l,
        alerts: [{ ...l.alerts[0]!, counts: { from: '192.0.2.1' } }],
      }),
    ],
    [
      'a result code the contract does not name',
      (l: ReturnType<typeof list>) => ({
        ...l,
        alerts: [{ ...l.alerts[0]!, push_result: { delivered: 1 } }],
      }),
    ],
    [
      "a class that is not its rule's",
      (l: ReturnType<typeof list>) => ({ ...l, alerts: [{ ...l.alerts[0]!, class: 'serious' }] }),
    ],
    [
      'an organization name of 201 characters',
      (l: ReturnType<typeof list>) => ({
        ...l,
        alerts: [{ ...l.alerts[0]!, organization_name: 'x'.repeat(201) }],
      }),
    ],
    [
      'a change of a name outside the fourteen',
      (l: ReturnType<typeof list>) => ({
        ...l,
        changes: [{ ...l.changes[0]!, name: 'everything_on' }],
      }),
    ],
    [
      'a switch change that is not a boolean',
      (l: ReturnType<typeof list>) => ({
        ...l,
        changes: [{ ...l.changes[0]!, name: 'email_on', old_value: 'off' }],
      }),
    ],
  ])('%s is not read', (_what, change) => {
    expect(readSecurityAlertList(change(list())).ok).toBe(false);
  });

  it('a run token in the heartbeat never reaches the view: the reader keeps only what it reads', () => {
    const token = '55555555-5555-4555-8555-555555555555';
    const l = list();
    const read = readSecurityAlertList({
      ...l,
      state: { ...l.state, heartbeat: { ...l.state.heartbeat, last_run_id: token } },
    });
    expect(read.ok && read.value !== null).toBe(true);
    expect(JSON.stringify(read)).not.toContain(token);
  });
});

/* ─────────────────── a later additive change to a function (S3) ─────────────────── */

describe('the readers take a key they do not know, and still refuse a needed one missing or mistyped', () => {
  /** Value maps whose keys are data (a reason, a code, a count's name), not the answer's shape. */
  const VALUE_MAPS = new Set([
    'counts',
    'push_result',
    'email_result',
    'serious_pushes_last_day_by_reason',
  ]);
  /** Every object of an answer with one key more, as a later migration could add it. */
  const withKeyMore = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(withKeyMore);
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = VALUE_MAPS.has(k) ? x : withKeyMore(x);
    out.added_later = { by: 'a later migration', n: 1 };
    return out;
  };
  /** A value of a type the key never takes. */
  const mistyped = (v: unknown): unknown =>
    typeof v === 'string' ? 12345 : v === null || typeof v === 'object' ? 7 : 'not this type';

  const claimNotice = {
    outcome: 'new',
    refused: null,
    id: '11111111-1111-4111-8111-111111111111',
    disposition: 'held_with_notice',
    push: false,
    email: false,
    attempt: 1,
    open_key: null,
    notice: {
      id: '22222222-2222-4222-8222-222222222222',
      event_key: '2026-11-24T12:00Z',
      push: false,
      email: true,
      attempt: 1,
    },
  };
  const heartbeatStart = {
    step: 'start',
    refused: null,
    run_id: '33333333-3333-4333-8333-333333333333',
    previous: { started_at: pg(NOW - 10 * MIN), finished_at: pg(NOW - 9 * MIN), ok: true },
    last_ok_at: pg(NOW - 9 * MIN),
    missed_runs: 0,
    failures_in_a_row: 0,
    report_now: false,
    marked_not_sent: 0,
  };
  const busyInputs = () =>
    rawInputs({
      buckets: { [JUDGED]: { troubleRows: 2, events: 70, sources: 12 } },
      aimed: [{ org: ORG_A, cells: cells(LAST3, 9) }],
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 9) }],
      openStates: [{ rule: 'spike', key: key(JUDGED - 9 * BUCKET), reminders: ['1h'] }],
      seriousRetry: ['sign_in_not_me|2026-11-24T08:00Z'],
      retry: [{ rule: 'record_trouble', key: key(JUDGED - 6 * BUCKET), phase: 'started' }],
    });

  const READERS: Array<[string, (raw: unknown) => { ok: boolean }, Record<string, unknown>]> = [
    ['the inputs', readSecurityAlertInputs, busyInputs()],
    [
      "the inputs' refusal",
      readSecurityAlertInputs,
      { window: null, refused: 'no_state', generated_at: pg(NOW) },
    ],
    ['the claim', readSecurityAlertClaim, claimNotice],
    [
      "the claim's refusal",
      readSecurityAlertClaim,
      {
        ...claimNotice,
        outcome: 'refused',
        refused: 'already_open',
        id: null,
        disposition: null,
        attempt: null,
        open_key: '2026-11-24T10:20Z',
        notice: null,
      },
    ],
    ['the result', readSecurityAlertResult, { recorded: true, refused: null }],
    [
      "the result's refusal",
      readSecurityAlertResult,
      { recorded: false, refused: 'email_floor_due' },
    ],
    ["the heartbeat's start", readSecurityAlertHeartbeatStart, heartbeatStart],
    [
      "the heartbeat start's refusal",
      readSecurityAlertHeartbeatStart,
      { step: 'start', refused: 'no_state' },
    ],
    [
      "the heartbeat's finish",
      readSecurityAlertHeartbeatFinish,
      { step: 'finish', refused: null, failures_in_a_row: 3, report_now: true },
    ],
    [
      "the heartbeat finish's refusal",
      readSecurityAlertHeartbeatFinish,
      { step: 'finish', refused: 'not_the_latest_run' },
    ],
    [
      'the baseline',
      readSecurityAlertBaseline,
      {
        computed: true,
        refused: null,
        event_high: 40,
        source_high: 6,
        from: pg(NOW - 7 * DAY),
        to: pg(NOW),
        asked_from: pg(NOW - 7 * DAY),
        shortened: false,
        buckets: 1008,
        computed_at: pg(NOW),
      },
    ],
    [
      "the baseline's refusal",
      readSecurityAlertBaseline,
      { computed: false, refused: 'computed_recently', computed_at: pg(NOW) },
    ],
    ['the list', readSecurityAlertList, rawList()],
    ["the list's refusal", readSecurityAlertList, { refused: 'no_state', generated_at: pg(NOW) }],
  ];

  it.each(READERS)(
    '%s: a key more in every object of the answer reads the same',
    (_what, read, raw) => {
      const plain = read(raw);
      expect(plain.ok).toBe(true);
      expect(read(withKeyMore(raw))).toEqual(plain);
    },
  );

  it.each(READERS)(
    '%s: each of its keys missing, or of a type it never takes, is still not read',
    (_what, read, raw) => {
      for (const k of Object.keys(raw)) {
        const { [k]: _gone, ...without } = raw;
        expect(read(without).ok, `${k} missing`).toBe(false);
        expect(read(withKeyMore(without)).ok, `${k} missing, a key more`).toBe(false);
        expect(read({ ...raw, [k]: mistyped(raw[k]) }).ok, `${k} mistyped`).toBe(false);
      }
    },
  );

  it('a needed key inside the answer, missing, is still not read', () => {
    const drop = (o: Record<string, unknown>, k: string) => {
      const { [k]: _gone, ...rest } = o;
      return rest;
    };
    const inputs = busyInputs();
    const buckets = inputs.buckets as Array<Record<string, unknown>>;
    expect(
      readSecurityAlertInputs({ ...inputs, window: drop(inputs.window as never, 'to') }).ok,
    ).toBe(false);
    expect(
      readSecurityAlertInputs({
        ...inputs,
        buckets: [drop(buckets[0]!, 'sources'), ...buckets.slice(1)],
      }).ok,
    ).toBe(false);
    expect(
      readSecurityAlertClaim({ ...claimNotice, notice: drop(claimNotice.notice, 'attempt') }).ok,
    ).toBe(false);
    expect(
      readSecurityAlertHeartbeatStart({
        ...heartbeatStart,
        previous: drop(heartbeatStart.previous, 'ok'),
      }).ok,
    ).toBe(false);
    const l = rawList();
    expect(
      readSecurityAlertList({
        ...l,
        state: { ...l.state, heartbeat: drop(l.state.heartbeat, 'last_run_partial') },
      }).ok,
    ).toBe(false);
    expect(readSecurityAlertList({ ...l, alerts: [drop(l.alerts[0]!, 'disposition')] }).ok).toBe(
      false,
    );
  });
});
