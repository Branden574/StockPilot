import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALERT_CLAIM_REFUSALS,
  ALERT_EXPECTED_CLAIM_REFUSALS,
  ALERT_RESULT_REFUSALS,
  ALERT_THRESHOLD_DEFAULTS,
  alertBucketKey,
  alertSeriousKey,
} from '@stockpilot/core';

/**
 * The security alert job (part 5, stage 4a: RECORD ONLY), through its cron
 * route. Security invariant. Pinned: CRON_SECRET fails closed before any
 * call; the contract's order (heartbeat start, inputs, serious retries,
 * serious flags, the other retries, the conditions, heartbeat finish), so
 * six cheap alerts never delay a serious flag; nothing is sent, and what a
 * switch would hand out is closed as record only (skipped, the email floor's
 * second result, the held notice); every refusal of every function is an
 * answer the job takes; a busy, failed, late or unreadable call stops the
 * claims and the run finishes not ok; once the start answered the finish is
 * always asked for, exactly once (twice only after a busy answer); the run
 * ends inside its deadline and never throws to the platform; two runs at
 * once do no harm; three missed or failed runs are reported once; the answer
 * and the log line hold no run id and no organization.
 *
 * A made-up database answers every function by its name (FakeDb below), as
 * the contract says it answers; a test replaces one answer where it needs.
 * Made-up data only.
 */

const h = vi.hoisted(() => ({
  env: {
    CRON_SECRET: 'cron-secret-for-tests' as string | undefined,
    STOCKPILOT_PLATFORM_ADMIN_EMAILS: 'owner@example.test,second@example.test' as
      string | undefined,
  },
  answer: vi.fn() as unknown as (fn: string, args: unknown) => unknown,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> | undefined }>,
  report: vi.fn(async (_e: unknown, _c: unknown) => undefined),
  adminThrows: false,
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('@/lib/error-reporter', () => ({ reportError: h.report }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (h.adminThrows) throw new Error('supabaseUrl is required');
    return {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        h.calls.push({ fn, args });
        const answer = Promise.resolve().then(() => h.answer(fn, args));
        return { abortSignal: () => answer };
      },
    };
  },
}));

import * as route from './route';
import { __resetAlertJobReportsForTests } from '@/server/security/alerts-reports';

const AUTH = { authorization: 'Bearer cron-secret-for-tests' };
const req = (headers: Record<string, string> = AUTH) =>
  new Request('https://app.example.com/api/cron/security-alerts', { headers });

/* ─────────────────────────────── made-up answers ─────────────────────────────── */

const MIN = 60_000;
const BUCKET = 10 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 24, 12, 5, 30);
const JUDGED = Math.floor(NOW / BUCKET) * BUCKET - BUCKET;
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const pg = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const key = (ms: number) => alertBucketKey(ms)!;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Shape {
  serious?: Array<{ reason: string; hour: number; flood?: boolean }>;
  seriousRetry?: string[];
  retry?: Array<{ rule: string; key: string; phase: string; subject?: string }>;
  aimed?: Array<{ org: string; events: number }>;
  trouble?: boolean;
  openStates?: Array<{ rule: string; key: string; subject?: string; reminders?: string[] }>;
  shortened?: boolean;
  truncated?: 'aimed' | 'open';
}

/** platform_security_alert_inputs() as the contract shapes it. */
function rawInputs(o: Shape = {}): Record<string, unknown> {
  const askedFrom = Math.floor((NOW - 8 * HOUR) / BUCKET) * BUCKET + BUCKET;
  const from = o.shortened ? askedFrom + 2 * HOUR + 3 * MIN : askedFrom;
  const buckets = [];
  for (
    let b = Math.floor(from / BUCKET) * BUCKET;
    b <= Math.floor(NOW / BUCKET) * BUCKET;
    b += BUCKET
  ) {
    const trouble = o.trouble && b === JUDGED ? 2 : 0;
    buckets.push({
      bucket_start: pg(b),
      bucket_key: key(b),
      partial: b < from || b + BUCKET > NOW,
      events: 0,
      sources: 0,
      trouble_rows: trouble,
      trouble_events: trouble * 9,
    });
  }
  const last3 = [JUDGED - 2 * BUCKET, JUDGED - BUCKET, JUDGED];
  return {
    serious: (o.serious ?? []).map((s) => ({
      reason: s.reason,
      hour: pg(s.hour),
      event_key: alertSeriousKey(s.reason, s.hour),
      flagged_in_flood: s.flood ?? false,
      events: 3,
      at_least: false,
      tally: false,
      first_minute: pg(s.hour + 2 * MIN),
      last_minute: pg(s.hour + 4 * MIN),
    })),
    aimed: (o.aimed ?? []).map((a) => ({
      organization_id: a.org,
      events: a.events * 3,
      buckets: last3.map((b) => ({ bucket_start: pg(b), bucket_key: key(b), events: a.events })),
    })),
    aimed_truncated: o.truncated === 'aimed',
    buckets,
    open_states: (o.openStates ?? []).map((s) => ({
      rule: s.rule,
      subject: s.subject ?? '',
      event_key: s.key,
      started_claimed_at: pg(NOW - 2 * HOUR),
      held: false,
      reminders: s.reminders ?? [],
    })),
    open_states_truncated: o.truncated === 'open',
    serious_retry_due: (o.seriousRetry ?? []).map((k) => ({
      rule: 'serious_flag',
      subject: '',
      event_key: k,
      phase: 'started',
      claimed_at: pg(NOW - 7 * MIN),
    })),
    serious_retry_due_truncated: false,
    retry_due: (o.retry ?? []).map((r) => ({
      rule: r.rule,
      subject: r.subject ?? '',
      event_key: r.key,
      phase: r.phase,
      claimed_at: pg(NOW - 6 * MIN),
    })),
    retry_due_truncated: false,
    window: { from: pg(from), to: pg(NOW + MIN), asked_from: pg(askedFrom) },
    shortened: from > askedFrom,
    refused: null,
    generated_at: pg(NOW),
    bucket_seconds: 600,
    oldest_event_at: pg(NOW - 3 * DAY),
    thresholds: { ...ALERT_THRESHOLD_DEFAULTS },
    baseline: {
      event_high: null,
      source_high: null,
      event_mark: 50,
      source_mark: 10,
      from: null,
      to: null,
      shortened: null,
      computed_at: null,
    },
    switches: { email_on: false, push_on: false, summary_on: false },
    planned_check_until: null,
  };
}

const SERIOUS_KEY = 'unrecorded_server_form_password|2026-11-24T11:00Z';
const RETRY_KEY = 'sign_in_not_me|2026-11-24T10:00Z';
/** One of everything, in an order unlike the contract's. */
const EVERYTHING: Shape = {
  aimed: [
    { org: ORG_A, events: 30 },
    { org: ORG_B, events: 9 },
  ],
  trouble: true,
  retry: [
    { rule: 'aimed_guessing', subject: ORG_B, key: key(JUDGED - 6 * BUCKET), phase: 'started' },
    { rule: 'alerts_held', key: key(JUDGED - 6 * BUCKET), phase: 'started' },
  ],
  serious: [{ reason: 'unrecorded_server_form_password', hour: Date.UTC(2026, 10, 24, 11) }],
  seriousRetry: [RETRY_KEY],
};

interface Row {
  id: string;
  rule: string;
  attempts: number;
  push: boolean;
  email: boolean;
  disposition: string;
  resulted: boolean;
  /** Claimed 5 minutes ago or more with no result: its next claim is its retry. */
  due?: boolean;
}

/** The database as the contract says it answers, made up. */
class FakeDb {
  inputs: unknown = rawInputs();
  /** What a new claim hands out (both off: record_only). */
  handOut = { push: false, email: false };
  /** A new claim's answer carries a held notice. */
  notice: { push: boolean; email: boolean } | null = null;
  reportNowAt: 'start' | 'finish' | 'both' | null = null;
  rows = new Map<string, Row>();
  latestRun: string | null = null;
  finished = new Set<string>();
  runs = 0;
  ids = 100;
  /** The rows behind the inputs' retry lists: claimed once, record only, no result. */
  seedRetries(o: Shape): void {
    const seed = (rule: string, subject: string, eventKey: string, phase: string) =>
      this.rows.set(`${rule}|${subject}|${eventKey}|${phase}`, {
        id: uuid((this.ids += 1)),
        rule,
        attempts: 1,
        push: false,
        email: false,
        disposition: 'record_only',
        resulted: false,
        due: true,
      });
    for (const k of o.seriousRetry ?? []) seed('serious_flag', '', k, 'started');
    for (const r of o.retry ?? []) seed(r.rule, r.subject ?? '', r.key, r.phase);
  }
  answer(fn: string, args: Record<string, unknown> | undefined): { data: unknown; error: unknown } {
    const a = args ?? {};
    switch (fn) {
      case 'platform_security_alert_heartbeat':
        if (a.p_step === 'start') {
          this.runs += 1;
          const prev = this.latestRun;
          this.latestRun = uuid(this.runs);
          return {
            data: {
              step: 'start',
              refused: null,
              run_id: this.latestRun,
              previous: {
                started_at: prev ? pg(NOW - 10 * MIN) : null,
                finished_at: null,
                ok: null,
              },
              last_ok_at: null,
              missed_runs: 0,
              failures_in_a_row:
                this.reportNowAt === 'start' || this.reportNowAt === 'both' ? 3 : 0,
              report_now: this.reportNowAt === 'start' || this.reportNowAt === 'both',
              marked_not_sent: 0,
            },
            error: null,
          };
        }
        if (a.p_run_id !== this.latestRun)
          return { data: { step: 'finish', refused: 'not_the_latest_run' }, error: null };
        if (this.finished.has(String(a.p_run_id)))
          return { data: { step: 'finish', refused: 'already_finished' }, error: null };
        this.finished.add(String(a.p_run_id));
        return {
          data: {
            step: 'finish',
            refused: null,
            failures_in_a_row: a.p_ok ? 0 : 3,
            report_now: this.reportNowAt === 'finish' || this.reportNowAt === 'both',
          },
          error: null,
        };
      case 'platform_security_alert_inputs':
        return { data: this.inputs, error: null };
      case 'platform_security_alert_claim': {
        const k = `${a.p_rule}|${a.p_subject}|${a.p_event_key}|${a.p_phase}`;
        const was = this.rows.get(k);
        const base = { refused: null, push: false, email: false, open_key: null, notice: null };
        if (was?.due) {
          was.due = false;
          was.attempts = 2;
          return {
            data: {
              ...base,
              outcome: 'retry',
              id: was.id,
              disposition: was.disposition,
              push: was.push,
              email: was.email,
              attempt: 2,
            },
            error: null,
          };
        }
        if (was) {
          return {
            data: {
              ...base,
              outcome: 'duplicate',
              id: was.id,
              disposition: was.disposition,
              attempt: was.attempts,
            },
            error: null,
          };
        }
        if (a.p_rule === 'alerts_held') {
          return {
            data: {
              ...base,
              outcome: 'refused',
              refused: 'not_claimable',
              id: null,
              disposition: null,
              attempt: null,
            },
            error: null,
          };
        }
        const handed = this.handOut.push || this.handOut.email;
        const row: Row = {
          id: uuid((this.ids += 1)),
          rule: String(a.p_rule),
          attempts: 1,
          push: this.handOut.push,
          email: this.handOut.email,
          disposition: this.notice ? 'held_with_notice' : handed ? 'sent' : 'record_only',
          resulted: false,
        };
        this.rows.set(k, row);
        let notice = null;
        if (this.notice) {
          const id = uuid((this.ids += 1));
          this.rows.set(`notice|${id}`, {
            id,
            rule: 'alerts_held',
            attempts: 1,
            push: this.notice.push,
            email: this.notice.email,
            disposition: 'sent',
            resulted: false,
          });
          notice = {
            id,
            event_key: key(JUDGED + BUCKET),
            push: this.notice.push,
            email: this.notice.email,
            attempt: 1,
          };
          this.notice = null;
          row.push = false;
          row.email = false;
        }
        return {
          data: {
            ...base,
            outcome: 'new',
            id: row.id,
            disposition: row.disposition,
            push: row.push,
            email: row.email,
            attempt: 1,
            notice,
          },
          error: null,
        };
      }
      case 'platform_security_alert_result': {
        const row = [...this.rows.values()].find((r) => r.id === a.p_id);
        const refuse = (refused: string) => ({ data: { recorded: false, refused }, error: null });
        if (!row) return refuse('not_an_alert');
        if (!row.push && !row.email) return refuse('nothing_to_record');
        if (row.resulted) return refuse('already_recorded');
        if (a.p_attempt !== row.attempts) return refuse('not_this_attempt');
        const pushR = a.p_push_result as Record<string, number> | null;
        const emailR = a.p_email_result as Record<string, number> | null;
        const floor =
          row.rule === 'serious_flag' &&
          row.push &&
          !row.email &&
          pushR !== null &&
          !((pushR.sent ?? 0) > 0);
        if (floor && emailR === null) return refuse('email_floor_due');
        if ((pushR !== null) !== row.push || ((emailR !== null) !== row.email && !floor))
          return refuse('not_its_channels');
        row.resulted = true;
        return { data: { recorded: true, refused: null }, error: null };
      }
      default:
        return { data: null, error: { code: 'PGRST202', message: `no function ${fn}` } };
    }
  }
}

let db: FakeDb;

beforeEach(() => {
  h.env.CRON_SECRET = 'cron-secret-for-tests';
  h.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS = 'owner@example.test,second@example.test';
  h.calls = [];
  h.adminThrows = false;
  db = new FakeDb();
  h.answer = vi.fn((fn: string, args: unknown) => db.answer(fn, args as Record<string, unknown>));
  h.report.mockReset();
  h.report.mockResolvedValue(undefined);
  __resetAlertJobReportsForTests();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(request = req()) {
  const res = await route.GET(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The calls, each as a short label: `claim serious_flag started <key>`. */
const labels = () =>
  h.calls.map(({ fn, args }) => {
    const name = fn.replace('platform_security_alert_', '');
    if (name === 'heartbeat') return `heartbeat ${args?.p_step}`;
    if (name === 'claim') {
      const subject = args?.p_subject ? ` ${String(args.p_subject).slice(0, 4)}` : '';
      return `claim ${args?.p_rule}${subject} ${args?.p_phase} ${args?.p_event_key}`;
    }
    if (name === 'result') return `result ${args?.p_id}`;
    return name;
  });
const claims = () => labels().filter((l) => l.startsWith('claim '));
const finishes = () =>
  h.calls.filter(
    (c) => c.fn === 'platform_security_alert_heartbeat' && c.args?.p_step === 'finish',
  );

/* ──────────────────────────────────── the secret ──────────────────────────────────── */

describe('the secret', () => {
  it('refuses without CRON_SECRET set, with no secret, and with a wrong one, before any call', async () => {
    // Unset or empty: refused whatever is sent, the words an unset secret would make included.
    for (const secret of [undefined, '']) {
      h.env.CRON_SECRET = secret;
      for (const authorization of [
        'Bearer cron-secret-for-tests',
        'Bearer undefined',
        'Bearer ',
        'Bearer',
      ]) {
        expect((await run(req({ authorization }))).status).toBe(401);
      }
    }
    h.env.CRON_SECRET = 'cron-secret-for-tests';
    expect((await run(req({}))).status).toBe(401);
    expect((await run(req({ authorization: 'Bearer not-the-secret' }))).status).toBe(401);
    expect((await run(req({ authorization: 'cron-secret-for-tests' }))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('exports GET only (a Vercel Cron job), with a 60 s limit', () => {
    const handlers = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(handlers).toEqual(['GET']);
    expect(route.maxDuration).toBe(60);
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('vercel.json runs it every 10 minutes', () => {
    const vercel = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../../vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/cron/security-alerts')).toEqual([
      { path: '/api/cron/security-alerts', schedule: '*/10 * * * *' },
    ]);
  });
});

/* ──────────────────────────────────── the order ──────────────────────────────────── */

describe("the contract's order", () => {
  it('start, inputs, serious retries, serious flags, the other retries, the conditions, finish', async () => {
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(labels()).toEqual([
      'heartbeat start',
      'inputs',
      `claim serious_flag started ${RETRY_KEY}`,
      `claim serious_flag started ${SERIOUS_KEY}`,
      `claim aimed_guessing 0b0b started ${key(JUDGED - 6 * BUCKET)}`,
      `claim alerts_held started ${key(JUDGED - 6 * BUCKET)}`,
      `claim record_trouble started ${key(JUDGED)}`,
      // Busiest first, each keyed by the oldest bucket of the look-back where it holds (the
      // threshold is 20 in 30 minutes): 30 a bucket holds from the first; 9 a bucket at the third.
      `claim aimed_guessing 0a0a started ${key(JUDGED - 2 * BUCKET)}`,
      `claim aimed_guessing 0b0b started ${key(JUDGED)}`,
      'heartbeat finish',
    ]);
    expect(body).toMatchObject({ ran: true, ok: true, partial: false, finish: 'recorded' });
    expect(body.unexpected).toEqual({});
    expect(body.retries).toMatchObject({ retry: 2 });
    expect((body.serious as Record<string, number>).retry).toBe(1);
  });

  it('a key a later migration adds to every answer is ignored: the same run, nothing unexpected', async () => {
    db.inputs = { ...rawInputs(EVERYTHING), added_later: 1 };
    db.seedRetries(EVERYTHING);
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = db.answer(fn, args as Record<string, unknown>);
      return a.data !== null && typeof a.data === 'object'
        ? { data: { ...(a.data as object), added_later: 1 }, error: null }
        : a;
    });
    const { body } = await run();
    expect(labels()).toHaveLength(10);
    expect(labels().at(-1)).toBe('heartbeat finish');
    expect(body).toMatchObject({ ran: true, ok: true, finish: 'recorded', unexpected: {} });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('six cheap alerts do not delay a serious flag', async () => {
    db.inputs = rawInputs({
      aimed: [
        ORG_A,
        ORG_B,
        '0c0c0c0c-0000-4000-8000-00000000000c',
        '0d0d0d0d-0000-4000-8000-00000000000d',
      ].map((org) => ({ org, events: 30 })),
      trouble: true,
      retry: [{ rule: 'spike', key: key(JUDGED - 6 * BUCKET), phase: 'started' }],
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 11) }],
    });
    await run();
    const order = claims();
    expect(order).toHaveLength(7);
    expect(order[0]).toBe('claim serious_flag started sign_in_not_me|2026-11-24T11:00Z');
    expect(order.slice(1).every((c) => !c.includes('serious_flag'))).toBe(true);
  });

  it('several serious flags of one reason and of several, and several retries: every one is claimed, before any volume or record claim', async () => {
    const at = (hour: number) => Date.UTC(2026, 10, 24, hour);
    const shape: Shape = {
      serious: [
        { reason: 'sign_in_not_me', hour: at(6) },
        { reason: 'sign_in_not_me', hour: at(7) },
        { reason: 'passkey_counter_went_back', hour: at(7) },
        { reason: 'over_buffer_cap', hour: at(8), flood: true },
        { reason: 'unrecorded_server_form_code', hour: at(9) },
        { reason: 'unrecorded_server_form_code', hour: at(10) },
      ],
      seriousRetry: [
        'sign_in_not_me|2026-11-24T05:00Z',
        'passkey_unexplained_sign_in|2026-11-24T05:00Z',
      ],
      aimed: [{ org: ORG_A, events: 30 }],
      trouble: true,
      retry: [{ rule: 'spike', key: key(JUDGED - 6 * BUCKET), phase: 'started' }],
    };
    db.inputs = rawInputs(shape);
    db.seedRetries(shape);
    const { body } = await run();
    expect(claims()).toEqual([
      'claim serious_flag started sign_in_not_me|2026-11-24T05:00Z',
      'claim serious_flag started passkey_unexplained_sign_in|2026-11-24T05:00Z',
      'claim serious_flag started sign_in_not_me|2026-11-24T06:00Z',
      'claim serious_flag started sign_in_not_me|2026-11-24T07:00Z',
      'claim serious_flag started passkey_counter_went_back|2026-11-24T07:00Z',
      'claim serious_flag started over_buffer_cap|2026-11-24T08:00Z',
      'claim serious_flag started unrecorded_server_form_code|2026-11-24T09:00Z',
      'claim serious_flag started unrecorded_server_form_code|2026-11-24T10:00Z',
      `claim spike started ${key(JUDGED - 6 * BUCKET)}`,
      `claim record_trouble started ${key(JUDGED)}`,
      `claim aimed_guessing 0a0a started ${key(JUDGED - 2 * BUCKET)}`,
    ]);
    expect(body.serious).toMatchObject({ claims: 8, new: 6, retry: 2 });
    expect(body).toMatchObject({ ok: true, finish: 'recorded' });
  });

  it('the claim is sent the rule, subject, key, phase and counts, from the inputs', async () => {
    db.inputs = rawInputs({ aimed: [{ org: ORG_A, events: 30 }] });
    await run();
    const claim = h.calls.find((c) => c.fn === 'platform_security_alert_claim')!;
    expect(claim.args).toEqual({
      p_rule: 'aimed_guessing',
      p_subject: ORG_A,
      p_event_key: key(JUDGED - 2 * BUCKET),
      p_phase: 'started',
      p_counts: { events: 30, minutes: 30 },
    });
    const finish = finishes()[0]!;
    expect(finish.args).toEqual({
      p_step: 'finish',
      p_run_id: uuid(1),
      p_ok: true,
      p_partial: false,
    });
  });
});

/* ──────────────────────────────────── record only ──────────────────────────────────── */

describe('record only: nothing is sent, and what is handed out is closed', () => {
  it('a record_only claim hands out nothing and asks for no result', async () => {
    db.inputs = rawInputs({
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 11) }],
    });
    const { body } = await run();
    expect(labels().filter((l) => l.startsWith('result'))).toEqual([]);
    expect(body).toMatchObject({ ok: true, closedRecordOnly: 0 });
    expect(h.report).not.toHaveBeenCalled();
  });

  it('a channel handed out is recorded as skipped, for every recipient, on exactly its channels', async () => {
    db.inputs = rawInputs({ trouble: true });
    db.handOut = { push: false, email: true };
    const { body } = await run();
    const result = h.calls.find((c) => c.fn === 'platform_security_alert_result')!;
    expect(result.args).toEqual({
      p_id: uuid(101),
      p_attempt: 1,
      p_push_result: null,
      p_email_result: { skipped: 2 },
    });
    expect(body).toMatchObject({ ok: true, closedRecordOnly: 1 });
    // Once per run: a switch is on and this release sends nothing. Counts only.
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-alerts.channel_on',
      level: 'warning',
      extra: { closed: 1, notices: 0 },
    });
  });

  it("a serious flag's push that so reached no one is owed its email: the second result has both", async () => {
    db.inputs = rawInputs({
      serious: [{ reason: 'passkey_counter_went_back', hour: Date.UTC(2026, 10, 24, 11) }],
    });
    db.handOut = { push: true, email: false };
    const { body } = await run();
    const results = h.calls
      .filter((c) => c.fn === 'platform_security_alert_result')
      .map((c) => c.args);
    expect(results).toEqual([
      { p_id: uuid(101), p_attempt: 1, p_push_result: { skipped: 2 }, p_email_result: null },
      {
        p_id: uuid(101),
        p_attempt: 1,
        p_push_result: { skipped: 2 },
        p_email_result: { skipped: 2 },
      },
    ]);
    expect(body).toMatchObject({ ok: true, closedRecordOnly: 1 });
  });

  it('a held notice in an answer is closed the same way, with attempt 1', async () => {
    db.inputs = rawInputs({ trouble: true });
    db.notice = { push: false, email: true };
    const { body } = await run();
    const results = h.calls
      .filter((c) => c.fn === 'platform_security_alert_result')
      .map((c) => c.args);
    expect(results).toEqual([
      { p_id: uuid(102), p_attempt: 1, p_push_result: null, p_email_result: { skipped: 2 } },
    ]);
    expect(body).toMatchObject({ ok: true, notices: 1, closedRecordOnly: 1 });
  });

  it('no allowlist: skipped 0 (a count only, never an address)', async () => {
    h.env.STOCKPILOT_PLATFORM_ADMIN_EMAILS = undefined;
    db.inputs = rawInputs({ trouble: true });
    db.handOut = { push: true, email: false };
    await run();
    expect(h.calls.find((c) => c.fn === 'platform_security_alert_result')!.args).toMatchObject({
      p_push_result: { skipped: 0 },
    });
  });

  it("a retry hands out the first claim's channels: closed with attempt 2", async () => {
    db.inputs = rawInputs({ seriousRetry: [RETRY_KEY] });
    h.answer = vi.fn((fn: string, args: unknown) =>
      fn === 'platform_security_alert_claim'
        ? {
            data: {
              outcome: 'retry',
              refused: null,
              id: uuid(7),
              disposition: 'sent',
              push: false,
              email: true,
              attempt: 2,
              open_key: null,
              notice: null,
            },
            error: null,
          }
        : fn === 'platform_security_alert_result'
          ? { data: { recorded: true, refused: null }, error: null }
          : db.answer(fn, args as Record<string, unknown>),
    );
    await run();
    expect(h.calls.find((c) => c.fn === 'platform_security_alert_result')!.args).toEqual({
      p_id: uuid(7),
      p_attempt: 2,
      p_push_result: null,
      p_email_result: { skipped: 2 },
    });
  });

  it.each(ALERT_RESULT_REFUSALS.filter((w) => w !== 'email_floor_due'))(
    'a result refused %s is an answer, counted as unexpected, and the run goes on',
    async (word) => {
      db.inputs = rawInputs({ trouble: true, aimed: [{ org: ORG_A, events: 30 }] });
      db.handOut = { push: false, email: true };
      h.answer = vi.fn((fn: string, args: unknown) =>
        fn === 'platform_security_alert_result'
          ? { data: { recorded: false, refused: word }, error: null }
          : db.answer(fn, args as Record<string, unknown>),
      );
      const { body } = await run();
      expect(claims()).toHaveLength(2);
      expect(body).toMatchObject({ ok: false, stop: 'unexpected', finish: 'recorded' });
      expect(body.unexpected).toEqual({ [`result_${word}`]: 2 });
    },
  );
});

/* ──────────────────────────────────── the claim's answers ──────────────────────────────────── */

describe('every refusal of the claim is an answer', () => {
  it.each(ALERT_CLAIM_REFUSALS)('refused %s', async (word) => {
    db.inputs = rawInputs({
      serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 11) }],
      trouble: true,
    });
    h.answer = vi.fn((fn: string, args: unknown) =>
      fn === 'platform_security_alert_claim'
        ? {
            data: {
              outcome: 'refused',
              refused: word,
              id: null,
              disposition: null,
              push: false,
              email: false,
              attempt: null,
              open_key: null,
              notice: null,
            },
            error: null,
          }
        : db.answer(fn, args as Record<string, unknown>),
    );
    const { status, body } = await run();
    expect(status).toBe(200);
    // Every claim is still made: a refusal never stops the run.
    expect(claims()).toHaveLength(2);
    expect(finishes()).toHaveLength(1);
    const expected = ALERT_EXPECTED_CLAIM_REFUSALS.includes(word);
    expect(body.ok).toBe(expected);
    if (!expected) {
      expect(body.unexpected).toEqual({ [`claim_${word}`]: 2 });
      expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'cron.security-alerts.unexpected',
        level: 'warning',
        extra: { [`claim_${word}`]: 2 },
      });
    }
  });

  it('a start answered state_ended with no newer bucket is left to the next run, never claimed with the refused key', async () => {
    db.inputs = rawInputs({ trouble: true });
    h.answer = vi.fn((fn: string, args: unknown) =>
      fn === 'platform_security_alert_claim'
        ? {
            data: {
              outcome: 'refused',
              refused: 'state_ended',
              id: null,
              disposition: null,
              push: false,
              email: false,
              attempt: null,
              open_key: null,
              notice: null,
            },
            error: null,
          }
        : db.answer(fn, args as Record<string, unknown>),
    );
    const { body } = await run();
    expect(claims()).toEqual([`claim record_trouble started ${key(JUDGED)}`]);
    expect(body).toMatchObject({ ok: true, leftToNextRun: 1 });
  });

  it('a start answered already_open takes open_key as the state: its due reminder', async () => {
    db.inputs = rawInputs({ trouble: true });
    const openKey = key(Date.UTC(2026, 10, 24, 5, 50));
    let first = true;
    h.answer = vi.fn((fn: string, args: unknown) => {
      if (fn === 'platform_security_alert_claim' && first) {
        first = false;
        return {
          data: {
            outcome: 'refused',
            refused: 'already_open',
            id: null,
            disposition: null,
            push: false,
            email: false,
            attempt: null,
            open_key: openKey,
            notice: null,
          },
          error: null,
        };
      }
      return db.answer(fn, args as Record<string, unknown>);
    });
    await run();
    expect(claims()).toEqual([
      `claim record_trouble started ${key(JUDGED)}`,
      `claim record_trouble reminder ${openKey}+6h`,
    ]);
  });

  it.each([
    [
      'a key it reads missing',
      (d: Record<string, unknown>) => {
        const { open_key: _gone, ...rest } = d;
        return rest;
      },
    ],
    [
      'a word the contract does not name',
      (d: Record<string, unknown>) => ({ ...d, outcome: 'maybe' }),
    ],
  ])(
    'an answer that cannot be read (%s) stops the claims; the run finishes not ok',
    async (_w, change) => {
      db.inputs = rawInputs(EVERYTHING);
      db.seedRetries(EVERYTHING);
      h.answer = vi.fn((fn: string, args: unknown) => {
        const a = db.answer(fn, args as Record<string, unknown>);
        return fn === 'platform_security_alert_claim'
          ? { data: change(a.data as Record<string, unknown>), error: null }
          : a;
      });
      const { body } = await run();
      expect(claims()).toHaveLength(1);
      expect(body).toMatchObject({ ok: false, stop: 'unreadable', finish: 'recorded' });
      expect(finishes()[0]!.args).toMatchObject({ p_ok: false });
    },
  );

  it.each([
    ['busy (55P03)', { code: '55P03', message: 'lock timeout' }, 'busy'],
    ['an error', { code: 'XX000', message: 'boom' }, 'call_failed'],
  ])(
    'a claim that is %s stops the claims: no volume claim before a serious one',
    async (_w, error, stop) => {
      db.inputs = rawInputs(EVERYTHING);
      db.seedRetries(EVERYTHING);
      h.answer = vi.fn((fn: string, args: unknown) =>
        fn === 'platform_security_alert_claim'
          ? { data: null, error }
          : db.answer(fn, args as Record<string, unknown>),
      );
      const { body } = await run();
      expect(claims()).toEqual([`claim serious_flag started ${RETRY_KEY}`]);
      expect(body).toMatchObject({ ok: false, stop, finish: 'recorded' });
      expect(finishes()).toHaveLength(1);
    },
  );
});

/* ──────────────────────────────────── the start and the inputs ──────────────────────────────────── */

describe('the start', () => {
  it('busy (55P03): another run is mid-way; stop without a finish, nothing reported', async () => {
    h.answer = vi.fn(() => ({ data: null, error: { code: '55P03', message: 'lock timeout' } }));
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(labels()).toEqual(['heartbeat start']);
    expect(body).toMatchObject({ ran: false, skipped: 'another_run', finish: 'not_asked' });
    expect(h.report).not.toHaveBeenCalled();
  });

  it.each(['no_state', 'not_a_step'])(
    'refused %s: a deployment problem, reported; no finish',
    async (word) => {
      h.answer = vi.fn(() => ({
        data: { step: word === 'not_a_step' ? null : 'start', refused: word },
        error: null,
      }));
      const { body } = await run();
      expect(labels()).toEqual(['heartbeat start']);
      expect(body).toMatchObject({ ran: false, skipped: 'start_refused' });
      expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
        tag: 'cron.security-alerts.start_refused',
        level: 'error',
        extra: { refused: word },
      });
    },
  );

  it.each([
    ['missing (PGRST202)', { code: 'PGRST202', message: 'not found' }, true],
    ['not allowed (42501)', { code: '42501', message: 'permission denied' }, true],
    ['a network error', { message: 'fetch failed' }, false],
  ])(
    'a start that fails (%s) stops before a run; a deployment problem is reported',
    async (_w, error, reported) => {
      h.answer = vi.fn(() => ({ data: null, error }));
      const { body } = await run();
      expect(body).toMatchObject({ ran: false, skipped: 'start_failed' });
      expect(h.report).toHaveBeenCalledTimes(reported ? 1 : 0);
    },
  );

  it('an unreadable start is reported, and stops', async () => {
    h.answer = vi.fn(() => ({ data: { step: 'start', refused: null }, error: null }));
    const { body } = await run();
    expect(body).toMatchObject({ ran: false, skipped: 'start_failed' });
    expect(h.report).toHaveBeenCalledTimes(1);
  });
});

describe('the inputs', () => {
  it.each(['no_state', 'too_many_events_in_one_minute'])(
    'refused %s: finish(false), no claim',
    async (word) => {
      db.inputs = { window: null, refused: word, generated_at: pg(NOW) };
      const { body } = await run();
      expect(labels()).toEqual(['heartbeat start', 'inputs', 'heartbeat finish']);
      expect(finishes()[0]!.args).toEqual({
        p_step: 'finish',
        p_run_id: uuid(1),
        p_ok: false,
        p_partial: false,
      });
      expect(body).toMatchObject({ ok: false, stop: 'inputs_refused' });
      // no_state is a deployment problem; a flood in one minute is counted by the heartbeat.
      expect(h.report).toHaveBeenCalledTimes(word === 'no_state' ? 1 : 0);
    },
  );

  it.each([
    ['57014 (its own timeout)', { code: '57014', message: 'canceling statement' }, 0],
    ['missing (PGRST202)', { code: 'PGRST202', message: 'not found' }, 1],
    ['not allowed (42501)', { code: '42501', message: 'permission denied' }, 1],
  ])('failed %s: finish(false), no claim', async (_w, error, reports) => {
    h.answer = vi.fn((fn: string, args: unknown) =>
      fn === 'platform_security_alert_inputs'
        ? { data: null, error }
        : db.answer(fn, args as Record<string, unknown>),
    );
    const { body } = await run();
    expect(labels()).toEqual(['heartbeat start', 'inputs', 'heartbeat finish']);
    expect(body).toMatchObject({ ok: false, stop: 'inputs_failed' });
    expect(h.report).toHaveBeenCalledTimes(reports);
  });

  it('an answer this build cannot read: finish(false), reported once', async () => {
    const { buckets: _gone, ...withoutBuckets } = rawInputs();
    db.inputs = withoutBuckets;
    const { body } = await run();
    expect(labels()).toEqual(['heartbeat start', 'inputs', 'heartbeat finish']);
    expect(body).toMatchObject({ ok: false, stop: 'unreadable' });
    expect(
      h.report.mock.calls.some(
        ([, c]) =>
          (c as { tag: string }).tag === 'cron.security-alerts.inputs_unreadable' &&
          (c as { extra: Record<string, unknown> }).extra.where === 'answer.buckets',
      ),
    ).toBe(true);
  });

  it.each([
    ['shortened', { shortened: true }],
    ['aimed_truncated', { truncated: 'aimed' as const }],
    ['open_states_truncated', { truncated: 'open' as const }],
  ])(
    'a partial read (%s): every serious flag is claimed, no end, and the finish says partial',
    async (_w, partial) => {
      db.inputs = rawInputs({
        ...partial,
        serious: [{ reason: 'sign_in_not_me', hour: Date.UTC(2026, 10, 24, 11) }],
        openStates: [{ rule: 'aimed_guessing', subject: ORG_B, key: key(JUDGED - 12 * BUCKET) }],
      });
      const { body } = await run();
      expect(claims()).toEqual(['claim serious_flag started sign_in_not_me|2026-11-24T11:00Z']);
      expect(finishes()[0]!.args).toMatchObject({ p_ok: true, p_partial: true });
      expect(body).toMatchObject({ ok: true, partial: true });
    },
  );

  it('a whole read ends a state that is gone', async () => {
    db.inputs = rawInputs({
      openStates: [{ rule: 'aimed_guessing', subject: ORG_B, key: key(JUDGED - 12 * BUCKET) }],
    });
    await run();
    expect(claims()).toEqual([`claim aimed_guessing 0b0b ended ${key(JUDGED - 12 * BUCKET)}`]);
  });
});

/* ──────────────────────────────────── the finish and the reports ──────────────────────────────────── */

describe('the finish, always closed once the start answered', () => {
  it.each([
    ['the inputs throw', 'platform_security_alert_inputs'],
    ['a claim throws', 'platform_security_alert_claim'],
    ['a result throws', 'platform_security_alert_result'],
  ])('%s: the finish is asked for once, not ok; the route answers 200', async (_w, thrower) => {
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    db.handOut = { push: false, email: true };
    h.answer = vi.fn((fn: string, args: unknown) => {
      if (fn === thrower) throw new Error('fetch failed');
      return db.answer(fn, args as Record<string, unknown>);
    });
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(finishes()).toHaveLength(1);
    expect(finishes()[0]!.args).toMatchObject({ p_ok: false });
    expect(body).toMatchObject({ ran: true, ok: false, finish: 'recorded' });
  });

  it('a busy finish is asked once more, 500 ms later', async () => {
    let busyOnce = true;
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = args as Record<string, unknown>;
      if (fn === 'platform_security_alert_heartbeat' && a.p_step === 'finish' && busyOnce) {
        busyOnce = false;
        return { data: null, error: { code: '55P03', message: 'lock timeout' } };
      }
      return db.answer(fn, a);
    });
    const { body } = await run();
    expect(finishes()).toHaveLength(2);
    expect(body).toMatchObject({ finish: 'recorded' });
  });

  it.each(['already_finished', 'not_a_finish', 'no_state'])(
    'a finish refused %s is an answer',
    async (word) => {
      h.answer = vi.fn((fn: string, args: unknown) => {
        const a = args as Record<string, unknown>;
        return fn === 'platform_security_alert_heartbeat' && a.p_step === 'finish'
          ? { data: { step: 'finish', refused: word }, error: null }
          : db.answer(fn, a);
      });
      const { status, body } = await run();
      expect(status).toBe(200);
      expect(body.finish).toBe(word === 'already_finished' ? 'already_finished' : 'refused');
    },
  );

  it('three missed or failed runs: reported once, as an error, with the count only (start and finish both say it)', async () => {
    db.reportNowAt = 'start';
    await run();
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-alerts.failing',
      level: 'error',
      extra: { failuresInARow: 3, step: 'start' },
    });
    h.report.mockClear();
    db = new FakeDb();
    db.reportNowAt = 'finish';
    db.inputs = { window: null, refused: 'too_many_events_in_one_minute', generated_at: pg(NOW) };
    await run();
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'cron.security-alerts.failing',
      level: 'error',
      extra: { failuresInARow: 3, step: 'finish' },
    });
  });

  it('the failing report goes once in a run, even when the start and the finish both say report_now', async () => {
    db.reportNowAt = 'both';
    await run();
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it('a deployment problem on every run is reported once in 6 hours on this instance, not every 10 minutes', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    h.answer = vi.fn((fn: string, args: unknown) =>
      fn === 'platform_security_alert_inputs'
        ? { data: null, error: { code: 'PGRST202', message: 'not found' } }
        : db.answer(fn, args as Record<string, unknown>),
    );
    for (let i = 0; i < 36; i += 1) {
      vi.setSystemTime(NOW + i * 10 * MIN);
      expect((await run()).body).toMatchObject({ ran: true, ok: false, stop: 'inputs_failed' });
    }
    expect(h.report).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW + 6 * HOUR);
    await run();
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('a refusal it does not expect and a channel on, on every run: each reported once in 6 hours', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    db.handOut = { push: true, email: false };
    db.inputs = rawInputs(EVERYTHING);
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = db.answer(fn, args as Record<string, unknown>);
      const r = args as Record<string, unknown>;
      return fn === 'platform_security_alert_claim' && r.p_rule === 'record_trouble'
        ? {
            data: {
              outcome: 'refused',
              refused: 'not_a_key',
              id: null,
              disposition: null,
              push: false,
              email: false,
              attempt: null,
              open_key: null,
              notice: null,
            },
            error: null,
          }
        : a;
    });
    for (let i = 0; i < 6; i += 1) {
      vi.setSystemTime(NOW + i * 10 * MIN);
      db.rows.clear();
      await run();
    }
    const tags = h.report.mock.calls.map(([, c]) => (c as { tag: string }).tag);
    expect(tags.filter((t) => t.endsWith('.channel_on'))).toHaveLength(1);
    expect(tags.filter((t) => t.endsWith('.unexpected'))).toHaveLength(1);
  });

  it('every report holds nothing but a fixed tag, counts and codes', async () => {
    db.handOut = { push: true, email: false };
    db.reportNowAt = 'start';
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = db.answer(fn, args as Record<string, unknown>);
      const r = args as Record<string, unknown>;
      if (fn === 'platform_security_alert_claim' && r.p_rule === 'record_trouble')
        return { data: { ...(a.data as object), outcome: 'maybe' }, error: null };
      return a;
    });
    await run();
    expect(h.report.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [e, c] of h.report.mock.calls) {
      const ctx = c as { tag: string; level: string; extra: Record<string, unknown> };
      expect(ctx.tag).toMatch(/^cron\.security-alerts\.[a-z_]+$/);
      expect(String((e as Error).message)).not.toMatch(/0a0a|0b0b|example|\|/);
      for (const v of Object.values(ctx.extra)) {
        expect(
          typeof v === 'number' ? Number.isSafeInteger(v) : /^[A-Za-z0-9_.]{1,64}$/.test(String(v)),
          `${ctx.tag}: ${String(v)}`,
        ).toBe(true);
      }
      expect(JSON.stringify(ctx)).not.toMatch(/0a0a0a0a|0b0b0b0b|example\.test/);
    }
  });

  it('a report that throws or hangs never holds the run past its limit', async () => {
    vi.useFakeTimers({ now: NOW });
    db.reportNowAt = 'start';
    h.report.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const pending = run();
    await vi.advanceTimersByTimeAsync(4_100);
    const { status } = await pending;
    expect(status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
    h.report.mockImplementation(async () => {
      throw new Error('webhook down');
    });
    const again = run();
    await vi.advanceTimersByTimeAsync(10);
    expect((await again).status).toBe(200);
  });

  it('the answer and the log line hold no run id, no organization and no key subject', async () => {
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    const { body } = await run();
    const line = String(vi.mocked(console.info).mock.calls[0]![1]);
    for (const text of [JSON.stringify(body), line]) {
      expect(text).not.toContain(uuid(1));
      expect(text).not.toContain(ORG_A);
      expect(text).not.toContain(ORG_B);
    }
    expect(vi.mocked(console.info).mock.calls[0]![0]).toBe('[cron.security-alerts]');
  });
});

/* ──────────────────────────────────── time ──────────────────────────────────── */

describe('the deadline', () => {
  it('claims that each take 4.9 s: no claim starts past the deadline less the reserve; the finish is in time', async () => {
    vi.useFakeTimers({ now: NOW });
    db.inputs = rawInputs({
      aimed: Array.from({ length: 30 }, (_, i) => ({
        org: `0e0e0e0e-0000-4000-8000-${String(i).padStart(12, '0')}`,
        events: 30,
      })),
    });
    let finishAt = 0;
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = args as Record<string, unknown>;
      if (fn === 'platform_security_alert_claim') {
        return new Promise((resolve) => setTimeout(() => resolve(db.answer(fn, a)), 4_900));
      }
      if (fn === 'platform_security_alert_heartbeat' && a.p_step === 'finish')
        finishAt = Date.now();
      return db.answer(fn, a);
    });
    const started = Date.now();
    const pending = run();
    await vi.advanceTimersByTimeAsync(60_000);
    const { body } = await pending;
    expect(body).toMatchObject({ ok: false, stop: 'time_limit', finish: 'recorded' });
    expect(claims().length).toBeLessThan(30);
    expect(finishAt - started).toBeLessThanOrEqual(50_000);
  });

  it('a claim that never answers is cut at 5 s; the run stops and finishes', async () => {
    vi.useFakeTimers({ now: NOW });
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    let finishAt = 0;
    h.answer = vi.fn((fn: string, args: unknown) => {
      const a = args as Record<string, unknown>;
      if (fn === 'platform_security_alert_claim') return new Promise(() => undefined);
      if (fn === 'platform_security_alert_heartbeat' && a.p_step === 'finish')
        finishAt = Date.now();
      return db.answer(fn, a);
    });
    const started = Date.now();
    const pending = run();
    await vi.advanceTimersByTimeAsync(6_000);
    const { body } = await pending;
    expect(claims()).toHaveLength(1);
    expect(body).toMatchObject({ ok: false, stop: 'call_failed', finish: 'recorded' });
    expect(finishAt - started).toBeGreaterThanOrEqual(5_000);
    expect(finishAt - started).toBeLessThan(5_100);
  });

  it('a start that never answers is cut; nothing more is asked', async () => {
    vi.useFakeTimers({ now: NOW });
    h.answer = vi.fn(() => new Promise(() => undefined));
    const pending = run();
    await vi.advanceTimersByTimeAsync(6_000);
    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(labels()).toEqual(['heartbeat start']);
    expect(body).toMatchObject({ ran: false, skipped: 'start_failed' });
  });
});

/* ──────────────────────────────────── never throws; two runs ──────────────────────────────────── */

describe('never throws, and two runs at once do no harm', () => {
  it('a service client that cannot be made: the run stops before it starts, and answers 200', async () => {
    h.adminThrows = true;
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ran: false, skipped: 'start_failed' });
  });

  it('two overlapping runs: one row per alert, the first finish is not the latest run', async () => {
    db.inputs = rawInputs(EVERYTHING);
    db.seedRetries(EVERYTHING);
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const finishWords = [a.body.finish, b.body.finish].sort();
    expect(finishWords).toEqual(['not_the_latest_run', 'recorded']);
    // Every alert was inserted once and every retry taken once; the other
    // run's claim of each was a duplicate.
    const sum = (part: 'serious' | 'retries' | 'conditions', word: string) =>
      [a.body[part], b.body[part]]
        .map((o) => (o as Record<string, number>)[word]!)
        .reduce((x, y) => x + y, 0);
    expect([sum('serious', 'retry'), sum('serious', 'new'), sum('serious', 'duplicate')]).toEqual([
      1, 1, 2,
    ]);
    expect([sum('retries', 'retry'), sum('retries', 'duplicate')]).toEqual([2, 2]);
    expect([sum('conditions', 'new'), sum('conditions', 'duplicate')]).toEqual([3, 3]);
    // Three seeded rows, the serious flag, record trouble and two aimed starts.
    expect(db.rows.size).toBe(7);
  });
});
