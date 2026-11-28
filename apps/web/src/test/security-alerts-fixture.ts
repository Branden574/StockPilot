import {
  ALERT_RULES,
  ALERT_THRESHOLD_DEFAULTS,
  readSecurityAlertList,
  type SecurityAlertsView,
} from '@stockpilot/core';

/**
 * Made-up answers of platform_security_alert_list() (migration 0480) for the
 * console's alert tests: the database's document as the contract shapes it,
 * and the page's view of it (core's strict reader over that document, each
 * change's actor given a made-up email). Made-up data only: the repository
 * is public.
 */

export const FIXTURE_NOW = '2026-11-24T12:05:30+00:00';
export const FIXTURE_ORG = '0a0a0a0a-0000-4000-8000-00000000000a';
export const FIXTURE_ORG_NAME = 'Made-up Academy';
export const FIXTURE_ACTOR = '0f0f0f0f-0000-4000-8000-00000000000f';
export const FIXTURE_ACTOR_EMAIL = 'console-owner@example.test';

type Raw = Record<string, unknown>;

/** One alert as the list returns it. */
export function rawAlert(rule: keyof typeof ALERT_RULES, o: Raw = {}): Raw {
  return {
    rule,
    class: ALERT_RULES[rule],
    subject: rule === 'aimed_guessing' ? FIXTURE_ORG : '',
    organization_name: rule === 'aimed_guessing' ? FIXTURE_ORG_NAME : null,
    event_key: rule === 'serious_flag' ? 'sign_in_not_me|2026-11-24T11:00Z' : '2026-11-24T11:50Z',
    phase: 'started',
    counts: { events: 3 },
    disposition: 'record_only',
    push_planned: false,
    email_planned: false,
    push_counted: true,
    email_floor: null,
    push_result: null,
    email_result: null,
    attempts: 1,
    claimed_at: '2026-11-24T12:00:04+00:00',
    resulted_at: null,
    state_ended_at: null,
    awaiting_result: false,
    overdue: false,
    ...o,
  };
}

/** The alerts a record-only week could hold, newest first; and two from a switch that was on. */
export const FIXTURE_ALERTS: Raw[] = [
  rawAlert('serious_flag', { counts: { events: 3, tally: false } }),
  rawAlert('aimed_guessing', { counts: { events: 90, minutes: 30 }, push_counted: false }),
  rawAlert('record_trouble', {
    phase: 'reminder',
    event_key: '2026-11-24T05:50Z+6h',
    counts: { rows: 2, events: 18 },
  }),
  rawAlert('spike', {
    phase: 'ended',
    event_key: '2026-11-24T09:00Z',
    counts: { quiet_minutes: 30 },
    push_counted: false,
    state_ended_at: '2026-11-24T10:00:03+00:00',
  }),
  rawAlert('alerts_held', {
    event_key: '2026-11-24T08:00Z',
    disposition: 'sent',
    email_planned: true,
    push_counted: false,
    counts: { held: 7 },
    email_result: { skipped: 2 },
    resulted_at: '2026-11-24T08:00:05+00:00',
    claimed_at: '2026-11-24T08:00:04+00:00',
  }),
  rawAlert('serious_flag', {
    event_key: 'passkey_counter_went_back|2026-11-24T07:00Z',
    disposition: 'sent',
    email_planned: true,
    push_counted: false,
    email_floor: 'push_budget_spent',
    email_result: { skipped: 2 },
    resulted_at: '2026-11-24T07:10:05+00:00',
    claimed_at: '2026-11-24T07:10:04+00:00',
  }),
  rawAlert('record_trouble', {
    event_key: '2026-11-24T05:50Z',
    disposition: 'held_for_summary',
    push_counted: false,
    counts: { rows: 1, events: 9 },
    claimed_at: '2026-11-24T06:00:04+00:00',
  }),
];

/** One change as the list returns it. */
export function rawChange(name: string, oldValue: unknown, newValue: unknown, at: string): Raw {
  return {
    changed_at: at,
    actor_user_id: FIXTURE_ACTOR,
    name,
    old_value: oldValue,
    new_value: newValue,
  };
}

/** The whole answer: every switch off, thresholds at their defaults but one. */
export function rawSecurityAlertList(o: Raw = {}): Raw {
  const state = {
    email_on: false,
    push_on: false,
    summary_on: false,
    record_only: true,
    planned_check_until: null,
    thresholds: { ...ALERT_THRESHOLD_DEFAULTS, aimed_guessing_events: 40 },
    baseline: {
      event_high: 42,
      source_high: 7,
      from: '2026-11-17T15:00:00+00:00',
      to: '2026-11-24T15:00:00+00:00',
      shortened: false,
      computed_at: '2026-11-23T15:00:04+00:00',
    },
    heartbeat: {
      last_run_started_at: '2026-11-24T12:00:01+00:00',
      last_run_finished_at: '2026-11-24T12:00:06+00:00',
      last_run_ok: true,
      last_run_partial: false,
      last_ok_at: '2026-11-24T12:00:06+00:00',
      failures_in_a_row: 0,
      failure_reported_at: null,
    },
    ...((o.state as Raw | undefined) ?? {}),
  };
  const change = rawChange('aimed_guessing_events', 20, 40, '2026-11-20T18:30:00+00:00');
  return {
    refused: null,
    generated_at: FIXTURE_NOW,
    budget: {
      serious_pushes_last_hour: 1,
      serious_pushes_last_day_by_reason: { sign_in_not_me: 1 },
      volume_pushes_last_day: 2,
      volume_emails_last_day: 0,
      record_emails_last_day: 0,
    },
    alerts: FIXTURE_ALERTS,
    alerts_truncated: false,
    changes: [change],
    changes_truncated: false,
    latest_changes: [change],
    ...o,
    state,
  };
}

/** The page's view of an answer (core's reader over it), each actor given the made-up email. */
export function securityAlertsViewOf(raw: Raw = rawSecurityAlertList()): SecurityAlertsView {
  const read = readSecurityAlertList(raw);
  if (!read.ok || read.refused !== null) {
    throw new Error(`the fixture is not a list answer (${read.ok ? read.refused : read.where})`);
  }
  const withEmail = <C extends { actorUserId: string }>(c: C) => ({
    ...c,
    actorEmail: c.actorUserId === FIXTURE_ACTOR ? FIXTURE_ACTOR_EMAIL : null,
  });
  return {
    ...read.value,
    changes: read.value.changes.map(withEmail),
    latestChanges: read.value.latestChanges.map(withEmail),
  };
}
