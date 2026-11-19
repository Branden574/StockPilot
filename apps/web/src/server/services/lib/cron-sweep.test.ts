import { afterEach, describe, expect, it, vi } from 'vitest';

import { cronAttemptsTable } from '@/test/cron-attempts-table';
import { makeSupabaseStub } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  CLAIM_UNAVAILABLE,
  cronAttemptClaimer,
  cronAttemptRecorder,
  newestPerKey,
  oldestFirst,
  readCronAttempts,
  RETRY_FIRST_LIMIT,
  retryFirstOnce,
  rotateByClock,
  settledFailures,
  sweepOrder,
  sweepOrganizations,
  sweepUntilDeadline,
} from './cron-sweep';

/** A claim's answer when it must be the attempt's finish (a function). */
function finishOf<F>(claimed: F | null | typeof CLAIM_UNAVAILABLE): F {
  if (typeof claimed !== 'function') throw new Error(`expected a claim, got ${String(claimed)}`);
  return claimed;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `o${String(i).padStart(3, '0')}`);

describe('oldestFirst', () => {
  it('puts ids with no time first (in their given order), then oldest time first, ties stable', () => {
    const last = new Map([
      ['a', 300],
      ['b', 100],
      ['c', 200],
      ['e', 100],
    ]);
    expect(oldestFirst(['a', 'b', 'c', 'd', 'e', 'f'], last)).toEqual([
      'd',
      'f',
      'b',
      'e',
      'c',
      'a',
    ]);
  });

  it('treats a time that is not a number as no time', () => {
    expect(
      oldestFirst(
        ['a', 'b'],
        new Map([
          ['a', 5],
          ['b', Number.NaN],
        ]),
      ),
    ).toEqual(['b', 'a']);
  });
});

describe('newestPerKey', () => {
  it('keeps the newest parsable time per key', () => {
    const rows = [
      { k: 'a', t: '2026-11-01T00:00:00Z' },
      { k: 'a', t: '2026-11-03T00:00:00Z' },
      { k: 'b', t: 'not a date' },
      { k: 'a', t: '2026-11-02T00:00:00Z' },
    ];
    const out = newestPerKey(
      rows,
      (r) => r.k,
      (r) => r.t,
    );
    expect([...out]).toEqual([['a', Date.parse('2026-11-03T00:00:00Z')]]);
  });
});

describe('sweepUntilDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts nothing once the deadline is reached, and counts what it left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const started: string[] = [];
    const out = await sweepUntilDeadline(
      ['a', 'b', 'c', 'd'],
      { concurrency: 1, deadlineAt: 25 },
      async (id) => {
        started.push(id);
        vi.setSystemTime(Date.now() + 10);
        return id.toUpperCase();
      },
    );
    // a at 0, b at 10, c at 20; d would start at 30.
    expect(started).toEqual(['a', 'b', 'c']);
    expect(out.started).toBe(3);
    expect(out.leftForNextRun).toBe(1);
    expect(out.entries.map((e) => (e.started && e.ok ? e.value : null))).toEqual([
      'A',
      'B',
      'C',
      null,
    ]);
  });

  it('a throwing item is recorded and never stops the rest', async () => {
    const out = await sweepUntilDeadline(
      ['a', 'b', 'c'],
      { concurrency: 2, deadlineAt: Date.now() + 60_000 },
      async (id) => {
        if (id === 'a') throw new Error('boom');
        return id;
      },
    );
    expect(out.started).toBe(3);
    expect(out.entries[0]).toMatchObject({ started: true, ok: false });
    expect(out.entries.slice(1).map((e) => e.started && e.ok && e.value)).toEqual(['b', 'c']);
  });

  it('keeps at most `concurrency` items in flight', async () => {
    let inFlight = 0;
    let most = 0;
    await sweepUntilDeadline(
      ids(10),
      { concurrency: 3, deadlineAt: Date.now() + 60_000 },
      async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
      },
    );
    expect(most).toBe(3);
  });
});

describe('cron attempts (cron_sweep_attempts, 0469)', () => {
  it("reads one job's rows into last attempt and failures in a row", async () => {
    const stub = makeSupabaseStub({
      'cron_sweep_attempts.select': {
        data: [
          {
            organization_id: 'a',
            last_attempt_at: '2026-11-17T02:00:00.000Z',
            consecutive_failures: 2,
          },
          {
            organization_id: 'b',
            last_attempt_at: '2026-11-16T02:00:00.000Z',
            consecutive_failures: null,
          },
        ],
        error: null,
      },
    });
    const out = await readCronAttempts(stub.client, 'restore_points');
    expect([...out.lastAttempt]).toEqual([
      ['a', Date.parse('2026-11-17T02:00:00.000Z')],
      ['b', Date.parse('2026-11-16T02:00:00.000Z')],
    ]);
    expect([...out.failures]).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
    expect(stub.chainArgsAll.get('cron_sweep_attempts.select')![0]).toContainEqual([
      'job',
      'restore_points',
    ]);
  });

  it('stamps on start as a failure in advance, then corrects it: success resets, neither restores, failure keeps', async () => {
    const stub = makeSupabaseStub({ 'cron_sweep_attempts.insert': { data: null, error: null } });
    const rec = cronAttemptRecorder(stub.client, 'exception_sync', {
      failuresBefore: new Map([
        ['f', 2],
        ['s', 3],
        ['n', 4],
      ]),
      reportTag: 'test.attempts',
    });
    const finishF = rec.start('f');
    // The stamp is sent at start, before the caller's own work.
    expect(stub.chainArgsAll.get('cron_sweep_attempts.insert')).toHaveLength(1);
    expect(await finishF('failure')).toBe(3);
    expect(await rec.start('s')('success')).toBe(0);
    expect(await rec.start('n')('neither')).toBe(4);
    expect(await rec.start('new')('success')).toBe(0);
    const rows = (stub.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map(
      (args) =>
        args[0]![0] as { job: string; organization_id: string; consecutive_failures?: number },
    );
    expect(rows.map((r) => [r.organization_id, r.consecutive_failures])).toEqual([
      ['f', 3],
      ['s', 4],
      ['s', 0],
      ['n', 5],
      ['n', 4],
      ['new', 1],
      ['new', 0],
    ]);
    expect(new Set(rows.map((r) => r.job))).toEqual(new Set(['exception_sync']));
  });

  it('an attempt that never finishes (killed at maxDuration) is already counted as a failure', async () => {
    const stub = makeSupabaseStub({ 'cron_sweep_attempts.insert': { data: null, error: null } });
    const rec = cronAttemptRecorder(stub.client, 'restore_points', {
      failuresBefore: new Map([['k', 1]]),
      reportTag: 'test.attempts',
    });
    rec.start('k'); // the function is killed before finish is called
    const rows = (stub.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map(
      (args) => args[0]![0] as { organization_id: string; consecutive_failures?: number },
    );
    expect(rows).toEqual([
      expect.objectContaining({ organization_id: 'k', consecutive_failures: 2 }),
    ]);
  });

  it('with countFailures off, writes only the attempt time', async () => {
    const stub = makeSupabaseStub({ 'cron_sweep_attempts.insert': { data: null, error: null } });
    const rec = cronAttemptRecorder(stub.client, 'prewarm', {
      failuresBefore: new Map(),
      reportTag: 'test.attempts',
      countFailures: false,
    });
    await rec.start('a')('neither');
    await rec.start('b')('failure');
    const rows = (stub.chainArgsAll.get('cron_sweep_attempts.insert') ?? []).map(
      (args) => args[0]![0] as Record<string, unknown>,
    );
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([
      ['job', 'last_attempt_at', 'organization_id'],
      ['job', 'last_attempt_at', 'organization_id'],
    ]);
  });

  it('a failed write never throws and is reported once per run', async () => {
    reportError.mockClear();
    const stub = makeSupabaseStub({
      'cron_sweep_attempts.insert': { data: null, error: { message: 'write failed' } },
    });
    const rec = cronAttemptRecorder(stub.client, 'restore_points', {
      failuresBefore: new Map(),
      reportTag: 'test.attempts',
    });
    await rec.start('a')('failure');
    await rec.start('b')('failure');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tag: 'test.attempts', level: 'warning' });
  });
});

const DAY = 24 * 60 * 60_000;

describe('rotateByClock (the order when the attempt records cannot be read)', () => {
  it('is the same ids, turned to start somewhere else, and keeps one or none as is', () => {
    const list = ids(10);
    for (const slot of [0, 1, 2, 20_000]) {
      const out = rotateByClock(list, slot * DAY, DAY);
      expect([...out].sort()).toEqual(list);
      const start = list.indexOf(out[0]!);
      expect(out).toEqual([...list.slice(start), ...list.slice(0, start)]);
    }
    expect(rotateByClock(['a'], 5 * DAY, DAY)).toEqual(['a']);
    expect(rotateByClock([], 5 * DAY, DAY)).toEqual([]);
  });

  it('does not put the same first organizations first on consecutive runs', () => {
    const list = ids(100);
    const firsts = Array.from(
      { length: 10 },
      (_, k) => rotateByClock(list, (20_400 + k) * DAY, DAY)[0],
    );
    expect(new Set(firsts).size).toBe(10);
  });

  it('with C reached per run, every organization is reached within ceil(2.7 N / C) + 1 runs, from any start', () => {
    for (const n of [49, 96, 97, 144, 500, 1001]) {
      for (const perRun of [5, 30, 48]) {
        const bound = Math.ceil((2.7 * n) / perRun) + 1;
        for (const firstSlot of [0, 17, 20_400, 980_000]) {
          const list = ids(n);
          const reached = new Set<string>();
          let runs = 0;
          while (reached.size < n && runs <= bound) {
            for (const id of rotateByClock(list, (firstSlot + runs) * DAY, DAY).slice(0, perRun)) {
              reached.add(id);
            }
            runs += 1;
          }
          expect({ n, perRun, firstSlot, reachedAll: reached.size === n }).toEqual({
            n,
            perRun,
            firstSlot,
            reachedAll: true,
          });
        }
      }
    }
  });

  it('sweepOrder uses the attempt times when it has them, the clock when it does not', () => {
    const list = ['a', 'b', 'c'];
    expect(
      sweepOrder(
        list,
        new Map([
          ['a', 5],
          ['b', 1],
        ]),
        { now: 0, slotMs: DAY },
      ),
    ).toEqual(['c', 'b', 'a']);
    expect(sweepOrder(list, null, { now: 7 * DAY, slotMs: DAY })).toEqual(
      rotateByClock(list, 7 * DAY, DAY),
    );
  });
});

describe('sweepUntilDeadline stopWhen', () => {
  it('stops starting items once stopWhen says so, and counts them as left', async () => {
    let budget = 2;
    const out = await sweepUntilDeadline(
      ['a', 'b', 'c', 'd'],
      { concurrency: 1, deadlineAt: Date.now() + 60_000, stopWhen: () => budget <= 0 },
      async (id, index) => {
        budget -= 1;
        return `${id}${index}`;
      },
    );
    expect(out.entries.map((e) => (e.started && e.ok ? e.value : null))).toEqual([
      'a0',
      'b1',
      null,
      null,
    ]);
    expect(out.leftForNextRun).toBe(2);
  });
});

describe('cronAttemptClaimer (one run per organization per hold)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a new organization by insert, refuses a second claim within the hold, and claims again after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z'));
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const holdMs = 20 * 60 * 60_000;
    const claimer = () =>
      cronAttemptClaimer(stub.client, 'auto_reorder', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs,
      });

    const first = await claimer().claim('o1');
    expect(first).not.toBeNull();
    expect(table.rows).toEqual([
      {
        job: 'auto_reorder',
        organization_id: 'o1',
        last_attempt_at: '2026-11-17T08:00:00.000Z',
        consecutive_failures: 1,
      },
    ]);
    expect(await finishOf(first)('success')).toBe(0);
    expect(table.rows[0]!.consecutive_failures).toBe(0);

    // The same tick delivered again a few seconds later: held.
    vi.setSystemTime(Date.parse('2026-11-17T08:00:05.000Z'));
    expect(await claimer().claim('o1')).toBeNull();
    // A different job's line is its own.
    const other = await cronAttemptClaimer(stub.client, 'recurring_pos', {
      failuresBefore: new Map(),
      reportTag: 'test.attempts',
      holdMs,
    }).claim('o1');
    expect(other).not.toBeNull();

    // The next day's run.
    vi.setSystemTime(Date.parse('2026-11-18T08:00:00.000Z'));
    const nextDay = await claimer().claim('o1');
    expect(nextDay).not.toBeNull();
    expect(table.rows.find((r) => r.job === 'auto_reorder')!.last_attempt_at).toBe(
      '2026-11-18T08:00:00.000Z',
    );
  });

  it('two runs claiming the same organizations at once: each organization goes to exactly one', async () => {
    const table = cronAttemptsTable([
      // Reached yesterday (the update path) and never (the insert path).
      {
        job: 'daily_briefing',
        organization_id: 'old',
        last_attempt_at: new Date(Date.now() - DAY).toISOString(),
        consecutive_failures: 0,
      },
    ]);
    const stub = makeSupabaseStub(table.results);
    const make = () =>
      cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: 20 * 60 * 60_000,
      });
    const a = make();
    const b = make();
    const orgs = ['old', 'new1', 'new2'];
    const results = await Promise.all(
      orgs.flatMap((o) => [
        a.claim(o).then((f) => ['a', o, f !== null]),
        b.claim(o).then((f) => ['b', o, f !== null]),
      ]),
    );
    for (const o of orgs) {
      expect(results.filter(([, org, won]) => org === o && won)).toHaveLength(1);
    }
  });

  it('fails open on an error other than the key: runs the organization unclaimed, reported once', async () => {
    reportError.mockClear();
    const stub = makeSupabaseStub({
      'cron_sweep_attempts.update': {
        data: null,
        error: { message: 'relation "cron_sweep_attempts" does not exist', code: '42P01' },
      },
    });
    const claimer = cronAttemptClaimer(stub.client, 'auto_reorder', {
      failuresBefore: new Map([['o1', 2]]),
      reportTag: 'test.attempts',
      holdMs: DAY,
    });
    const f1 = await claimer.claim('o1');
    const f2 = await claimer.claim('o2');
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(await finishOf(f1)('success')).toBe(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'test.attempts',
      level: 'warning',
      extra: { step: 'claim', job: 'auto_reorder', code: '42P01' },
    });
    // Codes only: no database text, no organization id.
    const message = (reportError.mock.calls[0]![0] as Error).message;
    expect(message).toContain('(code 42P01)');
    expect(message).not.toMatch(/relation|cron_sweep_attempts|o1|o2/);
  });

  it('a failed attempt write (recorder or claim finish) is reported with its code only', async () => {
    reportError.mockClear();
    const stub = makeSupabaseStub({
      'cron_sweep_attempts.insert': {
        data: null,
        error: {
          message: 'new row for relation "cron_sweep_attempts" violates check',
          code: '23514',
        },
      },
    });
    const recorder = cronAttemptRecorder(stub.client, 'weekly_digest', {
      failuresBefore: new Map(),
      reportTag: 'test.attempts',
    });
    await recorder.start('o1')('success');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tag: 'test.attempts',
      level: 'warning',
      extra: { step: 'write', job: 'weekly_digest', code: '23514' },
    });
    expect((reportError.mock.calls[0]![0] as Error).message).not.toMatch(
      /relation|cron_sweep_attempts|o1/,
    );
  });

  it('by default also runs the organization unclaimed when the insert fails with an error other than the key', async () => {
    reportError.mockClear();
    const stub = makeSupabaseStub({
      'cron_sweep_attempts.update': { data: [], error: null },
      'cron_sweep_attempts.insert': {
        data: null,
        error: { message: 'permission denied for table cron_sweep_attempts', code: '42501' },
      },
    });
    const claimer = cronAttemptClaimer(stub.client, 'recurring_pos', {
      failuresBefore: new Map(),
      reportTag: 'test.attempts',
      holdMs: DAY,
      onClaimUnavailable: 'run',
    });
    const f = await claimer.claim('o1');
    expect(typeof f).toBe('function');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  describe("with onClaimUnavailable 'skip'", () => {
    const skipping = (stub: ReturnType<typeof makeSupabaseStub>) =>
      cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map([['o1', 2]]),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
      });

    const expectOneSkipReport = () => {
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, ctx] = reportError.mock.calls[0]!;
      expect(ctx).toEqual({
        tag: 'test.attempts',
        level: 'warning',
        extra: {
          step: 'claim',
          job: 'daily_briefing',
          code: expect.any(String),
          onClaimUnavailable: 'skip',
        },
      });
      // The code only: no organization id, no database message.
      expect(JSON.stringify(ctx)).not.toMatch(/o1|o2/);
      expect((err as Error).message).not.toMatch(/o1|o2|cron_sweep_attempts/);
    };

    it('skips the organization when the claim update fails, writes nothing, and reports once', async () => {
      reportError.mockClear();
      const stub = makeSupabaseStub({
        'cron_sweep_attempts.update': {
          data: null,
          error: { message: 'relation "cron_sweep_attempts" does not exist', code: '42P01' },
        },
      });
      const claimer = skipping(stub);
      expect(await claimer.claim('o1')).toBe(CLAIM_UNAVAILABLE);
      expect(await claimer.claim('o2')).toBe(CLAIM_UNAVAILABLE);
      // No insert and no upsert after the failed update.
      expect(stub.chainsAll.get('cron_sweep_attempts.insert') ?? []).toEqual([]);
      expectOneSkipReport();
      expect(reportError.mock.calls[0]![1].extra.code).toBe('42P01');
    });

    it('skips the organization when the claim insert fails with an error other than the key', async () => {
      reportError.mockClear();
      const stub = makeSupabaseStub({
        'cron_sweep_attempts.update': { data: [], error: null },
        'cron_sweep_attempts.insert': {
          data: null,
          error: { message: 'permission denied for table cron_sweep_attempts', code: '42501' },
        },
      });
      const claimer = skipping(stub);
      expect(await claimer.claim('o1')).toBe(CLAIM_UNAVAILABLE);
      expect(await claimer.claim('o2')).toBe(CLAIM_UNAVAILABLE);
      expectOneSkipReport();
      expect(reportError.mock.calls[0]![1].extra.code).toBe('42501');
    });

    it('still answers null for an organization another run holds (the key), with no report', async () => {
      reportError.mockClear();
      const table = cronAttemptsTable([
        {
          job: 'daily_briefing',
          organization_id: 'o1',
          last_attempt_at: new Date().toISOString(),
          consecutive_failures: 0,
        },
      ]);
      const stub = makeSupabaseStub(table.results);
      expect(await skipping(stub).claim('o1')).toBeNull();
      expect(reportError).not.toHaveBeenCalled();
    });

    it('retries once: a claim update that errors and then works claims the organization, with no report', async () => {
      reportError.mockClear();
      const table = cronAttemptsTable();
      let updates = 0;
      const stub = makeSupabaseStub({
        ...table.results,
        'cron_sweep_attempts.update': (call) =>
          ++updates === 1
            ? { data: null, error: { message: 'fetch failed', code: '' } }
            : table.results['cron_sweep_attempts.update'](call),
      });
      const claimer = cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
        retryDelayMs: 1,
      });
      expect(typeof (await claimer.claim('o1'))).toBe('function');
      expect(updates).toBe(2);
      expect(table.rows).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('retries once: a claim insert that errors and then works claims the organization', async () => {
      const table = cronAttemptsTable();
      let inserts = 0;
      const stub = makeSupabaseStub({
        ...table.results,
        'cron_sweep_attempts.insert': (call) =>
          ++inserts === 1
            ? { data: null, error: { message: 'permission denied', code: '42501' } }
            : table.results['cron_sweep_attempts.insert'](call),
      });
      const claimer = cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
        retryDelayMs: 1,
      });
      expect(typeof (await claimer.claim('o1'))).toBe('function');
      expect(inserts).toBe(2);
    });

    it('a first insert that committed but answered an error: the retry meets the key and answers held', async () => {
      reportError.mockClear();
      const table = cronAttemptsTable();
      let inserts = 0;
      const stub = makeSupabaseStub({
        ...table.results,
        'cron_sweep_attempts.insert': (call) => {
          const answer = table.results['cron_sweep_attempts.insert'](call);
          // The row is written, but the reply is lost.
          return ++inserts === 1
            ? { data: null, error: { message: 'fetch failed', code: '' } }
            : answer;
        },
      });
      const claimer = cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
        retryDelayMs: 1,
      });
      expect(await claimer.claim('o1')).toBeNull();
      expect(table.rows).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });

    it("an empty code is reported as 'unknown', in the message too", async () => {
      reportError.mockClear();
      const stub = makeSupabaseStub({
        'cron_sweep_attempts.update': { data: null, error: { message: 'fetch failed', code: '' } },
      });
      const claimer = cronAttemptClaimer(stub.client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
        retryDelayMs: 1,
      });
      expect(await claimer.claim('o1')).toBe(CLAIM_UNAVAILABLE);
      expect(claimer.unavailableCode).toBe('unknown');
      expect(reportError.mock.calls[0]![1].extra.code).toBe('unknown');
      expect((reportError.mock.calls[0]![0] as Error).message).toContain('(code unknown)');
    });

    it('stops retrying after three failed retries in a run, and never retries by default', async () => {
      let updates = 0;
      const failing = () =>
        makeSupabaseStub({
          'cron_sweep_attempts.update': () => {
            updates += 1;
            return { data: null, error: { message: 'down', code: '42P01' } };
          },
        });
      const skipping = cronAttemptClaimer(failing().client, 'daily_briefing', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
        onClaimUnavailable: 'skip',
        retryDelayMs: 1,
      });
      for (const o of ['o1', 'o2', 'o3', 'o4', 'o5']) {
        expect(await skipping.claim(o)).toBe(CLAIM_UNAVAILABLE);
      }
      // Three organizations tried twice, then once each.
      expect(updates).toBe(3 * 2 + 2);

      updates = 0;
      const running = cronAttemptClaimer(failing().client, 'auto_reorder', {
        failuresBefore: new Map(),
        reportTag: 'test.attempts',
        holdMs: DAY,
      });
      for (const o of ['o1', 'o2']) expect(typeof (await running.claim(o))).toBe('function');
      expect(updates).toBe(2);
    });

    it('claims as usual when the claim can be recorded', async () => {
      const table = cronAttemptsTable();
      const stub = makeSupabaseStub(table.results);
      const f = await skipping(stub).claim('o1');
      expect(typeof f).toBe('function');
      expect(table.rows).toHaveLength(1);
    });
  });
});

describe('sweepOrganizations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops at the deadline, says so, and the next run starts with the ones it left', async () => {
    reportError.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.parse('2026-11-17T08:00:00.000Z');
    vi.setSystemTime(now);
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const list = ids(6);
    const run = async () => {
      const started: string[] = [];
      const runStart = Date.now();
      const out = await sweepOrganizations(
        stub.client,
        {
          job: 'auto_reorder',
          tag: 'cron.test',
          orgIds: list,
          deadlineAt: runStart + 25_000,
          slotMs: DAY,
          holdMs: 20 * 60 * 60_000,
        },
        async (orgId) => {
          started.push(orgId);
          vi.setSystemTime(Date.now() + 10_000);
          return { result: 'success', value: orgId };
        },
      );
      return { started, out };
    };

    const night1 = await run();
    expect(night1.started).toEqual(['o000', 'o001', 'o002']);
    expect(night1.out).toMatchObject({
      leftForNextRun: 3,
      stoppedAtDeadline: true,
      orderedBy: 'attempts',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.test.deadline', level: 'warning' }),
    );

    now += DAY;
    vi.setSystemTime(now);
    const night2 = await run();
    expect(night2.started).toEqual(['o003', 'o004', 'o005']);
  });

  it('a tick delivered twice: each organization is worked once across both runs', async () => {
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const worked: string[] = [];
    const run = () =>
      sweepOrganizations(
        stub.client,
        {
          job: 'recurring_pos',
          tag: 'cron.test',
          orgIds: ids(8),
          deadlineAt: Date.now() + 60_000,
          slotMs: DAY,
          holdMs: 20 * 60 * 60_000,
        },
        async (orgId) => {
          worked.push(orgId);
          await new Promise((r) => setTimeout(r, 1));
          return { result: 'success', value: null };
        },
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect([...worked].sort()).toEqual(ids(8));
    expect(a.done.length + b.done.length).toBe(8);
    expect(a.heldByAnotherRun + b.heldByAnotherRun).toBe(8);
  });

  it('without a hold it records attempts only, so a second run works every organization again', async () => {
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    let worked = 0;
    const run = () =>
      sweepOrganizations(
        stub.client,
        {
          job: 'weekly_digest',
          tag: 'cron.test',
          orgIds: ids(3),
          deadlineAt: Date.now() + 60_000,
          slotMs: 7 * DAY,
        },
        async () => {
          worked += 1;
          return { result: 'success', value: null };
        },
      );
    await run();
    await run();
    expect(worked).toBe(6);
    expect(table.rows.map((r) => [r.job, r.consecutive_failures])).toEqual([
      ['weekly_digest', 0],
      ['weekly_digest', 0],
      ['weekly_digest', 0],
    ]);
  });

  it('a throw is reported and counted as a failure, and never stops the rest', async () => {
    reportError.mockClear();
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const out = await sweepOrganizations(
      stub.client,
      {
        job: 'auto_reorder',
        tag: 'cron.test',
        orgIds: ['a', 'b'],
        deadlineAt: Date.now() + 60_000,
        slotMs: DAY,
        holdMs: DAY / 2,
      },
      async (orgId) => {
        if (orgId === 'a') throw new Error('boom');
        return { result: 'success', value: orgId };
      },
    );
    expect(out.threw).toBe(1);
    expect(out.done).toEqual([{ orgId: 'b', value: 'b' }]);
    expect(table.rows.find((r) => r.organization_id === 'a')!.consecutive_failures).toBe(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.test.org', extra: { orgId: 'a' } }),
    );
  });

  describe('an organization whose claim cannot be recorded', () => {
    /** The attempts table, with the claim update for the organizations in
     *  `failing` answering an error (a refused write). */
    const flaky = () => {
      const table = cronAttemptsTable();
      const failing = new Set<string>();
      const update = table.results['cron_sweep_attempts.update'];
      const stub = makeSupabaseStub({
        ...table.results,
        'cron_sweep_attempts.update': (call) => {
          const orgId = call.args.find(
            (a, i) => call.methods[i] === 'eq' && a[0] === 'organization_id',
          )?.[1] as string;
          return failing.has(orgId)
            ? { data: null, error: { message: 'permission denied', code: '42501' } }
            : update(call);
        },
      });
      return { table, failing, client: stub.client };
    };

    const runDay = async (
      env: ReturnType<typeof flaky>,
      day: number,
      onClaimUnavailable?: 'skip' | 'run',
    ) => {
      vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z') + day * DAY);
      const worked: string[] = [];
      const out = await sweepOrganizations(
        env.client,
        {
          job: 'daily_briefing',
          tag: 'cron.test',
          orgIds: ['a', 'b', 'c'],
          deadlineAt: Date.now() + 60_000,
          slotMs: DAY,
          holdMs: 20 * 60 * 60_000,
          ...(onClaimUnavailable ? { onClaimUnavailable, retryDelayMs: 1 } : {}),
        },
        async (orgId) => {
          worked.push(orgId);
          // Each organization takes a second, so the stamps of one run differ.
          vi.setSystemTime(Date.now() + 1_000);
          return { result: 'success', value: orgId };
        },
      );
      return { worked, out };
    };

    it("with 'skip': it is not worked, is counted, is reported once, and goes first on the next run", async () => {
      reportError.mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
      const env = flaky();
      // Day 0: every claim recorded, in the order a, b, c.
      expect((await runDay(env, 0, 'skip')).worked).toEqual(['a', 'b', 'c']);

      // Day 1: the claim of 'a' (first in line) cannot be written.
      env.failing.add('a');
      const day1 = await runDay(env, 1, 'skip');
      expect(day1.worked).toEqual(['b', 'c']);
      expect(day1.out).toMatchObject({
        claimUnavailable: 1,
        heldByAnotherRun: 0,
        failed: 0,
        leftForNextRun: 0,
      });
      expect(day1.out.done.map((d) => d.orgId)).toEqual(['b', 'c']);
      // Its row still says day 0: the skip wrote nothing.
      expect(env.table.rows.find((r) => r.organization_id === 'a')!.last_attempt_at).toBe(
        '2026-11-17T08:00:00.000Z',
      );
      const claimReports = reportError.mock.calls.filter(
        ([, c]) => (c as { tag?: string }).tag === 'cron.test.attempts',
      );
      expect(claimReports).toHaveLength(1);
      expect(claimReports[0]![1]).toMatchObject({
        extra: { step: 'claim', job: 'daily_briefing', code: '42501' },
      });
      // Not every organization was skipped: no error-level report.
      expect(
        reportError.mock.calls.filter(
          ([, c]) => (c as { tag?: string }).tag === 'cron.test.claims_down',
        ),
      ).toHaveLength(0);

      // Day 2: the write works again, and 'a' is first in line.
      env.failing.clear();
      const day2 = await runDay(env, 2, 'skip');
      expect(day2.worked).toEqual(['a', 'b', 'c']);
      expect(day2.out.claimUnavailable).toBe(0);
    });

    it("with 'skip': a run that skips every organization it tried reports an error, with the code in the message", async () => {
      reportError.mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
      const env = flaky();
      for (const o of ['a', 'b', 'c']) env.failing.add(o);
      const run = await runDay(env, 0, 'skip');
      expect(run.worked).toEqual([]);
      expect(run.out.claimUnavailable).toBe(3);
      const down = reportError.mock.calls.filter(
        ([, c]) => (c as { tag?: string }).tag === 'cron.test.claims_down',
      );
      expect(down).toHaveLength(1);
      expect(down[0]![1]).toEqual({
        tag: 'cron.test.claims_down',
        level: 'error',
        extra: { job: 'daily_briefing', code: '42501', skipped: 3 },
      });
      expect((down[0]![0] as Error).message).toContain('(code 42501)');
      expect((down[0]![0] as Error).message).not.toMatch(/\ba\b|\bb\b|\bc\b/);
    });

    it("with 'skip': one organization held by another run and the rest skipped still reports the error (nothing was claimed)", async () => {
      reportError.mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
      const env = flaky();
      // 'a' was started by another run an hour before this one: held.
      env.table.rows.push({
        job: 'daily_briefing',
        organization_id: 'a',
        last_attempt_at: '2026-11-17T07:00:00.000Z',
        consecutive_failures: 0,
      });
      env.failing.add('b');
      env.failing.add('c');
      const run = await runDay(env, 0, 'skip');
      expect(run.worked).toEqual([]);
      expect(run.out).toMatchObject({ heldByAnotherRun: 1, claimUnavailable: 2 });
      const down = reportError.mock.calls.filter(
        ([, c]) => (c as { tag?: string }).tag === 'cron.test.claims_down',
      );
      expect(down).toHaveLength(1);
      expect(down[0]![1]).toMatchObject({ level: 'error', extra: { skipped: 2 } });
    });

    it("with 'skip': every organization held by another run is not an error", async () => {
      reportError.mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
      const env = flaky();
      for (const o of ['a', 'b', 'c']) {
        env.table.rows.push({
          job: 'daily_briefing',
          organization_id: o,
          last_attempt_at: '2026-11-17T07:00:00.000Z',
          consecutive_failures: 0,
        });
      }
      const run = await runDay(env, 0, 'skip');
      expect(run.out).toMatchObject({ heldByAnotherRun: 3, claimUnavailable: 0 });
      expect(
        reportError.mock.calls.filter(
          ([, c]) => (c as { tag?: string }).tag === 'cron.test.claims_down',
        ),
      ).toHaveLength(0);
    });

    it('by default (every job but the daily briefing and the price pull) it runs unclaimed, as before', async () => {
      reportError.mockClear();
      vi.useFakeTimers({ toFake: ['Date'] });
      const env = flaky();
      await runDay(env, 0);
      env.failing.add('a');
      const day1 = await runDay(env, 1);
      expect(day1.worked).toEqual(['a', 'b', 'c']);
      expect(day1.out.heldByAnotherRun).toBe(0);
      expect(day1.out.claimUnavailable ?? 0).toBe(0);
      expect(
        reportError.mock.calls.filter(
          ([, c]) => (c as { tag?: string }).tag === 'cron.test.attempts',
        ),
      ).toHaveLength(1);
    });
  });

  it('when the attempts cannot be read: reported, and the order turns with the clock instead of id order', async () => {
    reportError.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable([], { failRead: () => true });
    const stub = makeSupabaseStub(table.results);
    const firsts: string[] = [];
    for (let day = 0; day < 5; day += 1) {
      vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z') + day * DAY);
      const out = await sweepOrganizations(
        stub.client,
        {
          job: 'auto_reorder',
          tag: 'cron.test',
          orgIds: ids(50),
          deadlineAt: Date.now() + 60_000,
          slotMs: DAY,
          // No hold: each day's run works its whole list.
        },
        async (orgId) => ({ result: 'success', value: orgId }),
      );
      expect(out.orderedBy).toBe('clock');
      firsts.push(out.done[0]!.orgId);
    }
    expect(new Set(firsts).size).toBe(5);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'cron.test.attempts', level: 'warning' }),
    );
  });
});

describe('retryFirstOnce (an attempt that did not finish goes to the front once)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves the organizations at one failure in a row to the front, in order; two or more stay put', () => {
    const failures = new Map([
      ['c', 1],
      ['d', 2],
      ['e', 1],
    ]);
    expect(retryFirstOnce(['a', 'b', 'c', 'd', 'e'], failures)).toEqual({
      order: ['c', 'e', 'a', 'b', 'd'],
      promoted: 2,
    });
    expect(retryFirstOnce(['a', 'b'], new Map())).toEqual({ order: ['a', 'b'], promoted: 0 });
  });

  it('moves at most RETRY_FIRST_LIMIT (3) a run; the others keep their place', () => {
    expect(RETRY_FIRST_LIMIT).toBe(3);
    const failures = new Map(['b', 'c', 'd', 'e', 'f'].map((id) => [id, 1] as const));
    expect(retryFirstOnce(['a', 'b', 'c', 'd', 'e', 'f', 'g'], failures)).toEqual({
      order: ['b', 'c', 'd', 'a', 'e', 'f', 'g'],
      promoted: 3,
    });
  });

  it('settledFailures: success clears, failure adds one, neither keeps the count but clears a first failure', () => {
    expect(settledFailures('success', 4)).toBe(0);
    expect(settledFailures('failure', 0)).toBe(1);
    expect(settledFailures('failure', 2)).toBe(3);
    expect(settledFailures('neither', 0)).toBe(0);
    expect(settledFailures('neither', 1)).toBe(0);
    expect(settledFailures('neither', 2)).toBe(2);
    expect(settledFailures('neither', 5)).toBe(5);
  });

  it('an organization that failed once and then has nothing to do goes to the front once, not every run', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const list = ids(6);
    const LAST = list[5]!;
    const firsts: string[] = [];
    const promoted: number[] = [];
    for (let day = 0; day < 4; day += 1) {
      vi.setSystemTime(Date.parse('2026-11-17T08:00:00.000Z') + day * DAY);
      const out = await sweepOrganizations(
        stub.client,
        {
          job: 'auto_reorder',
          tag: 'cron.test',
          orgIds: list,
          deadlineAt: Date.now() + 60_000,
          slotMs: DAY,
          holdMs: 20 * 60 * 60_000,
        },
        async (orgId) => {
          // Day 0: it fails. From then on the job is off for it: neither.
          if (orgId === LAST) return { result: day === 0 ? 'failure' : 'neither', value: orgId };
          return { result: 'success', value: orgId };
        },
      );
      firsts.push(out.done[0]!.orgId);
      promoted.push(out.promoted);
    }
    // Day 1 moves it to the front (its first failure); its neither then
    // clears the count, so days 2 and 3 go in the plain order.
    expect(firsts[1]).toBe(LAST);
    expect(promoted).toEqual([0, 1, 0, 0]);
    expect(firsts[2]).not.toBe(LAST);
    expect(firsts[3]).not.toBe(LAST);
    expect(table.rows.find((r) => r.organization_id === LAST)!.consecutive_failures).toBe(0);
  });

  it('a neither after two or more failures leaves the count as it was', async () => {
    const table = cronAttemptsTable([
      {
        job: 'auto_reorder',
        organization_id: 'a',
        last_attempt_at: '2026-11-01T08:00:00.000Z',
        consecutive_failures: 2,
      },
    ]);
    const stub = makeSupabaseStub(table.results);
    const out = await sweepOrganizations(
      stub.client,
      {
        job: 'auto_reorder',
        tag: 'cron.test',
        orgIds: ['a'],
        deadlineAt: Date.now() + 60_000,
        slotMs: DAY,
        holdMs: 20 * 60 * 60_000,
      },
      async () => ({ result: 'neither', value: null }),
    );
    expect(out.promoted).toBe(0);
    expect(table.rows.find((r) => r.organization_id === 'a')!.consecutive_failures).toBe(2);
  });

  it('40 organizations of 4 s and one of 150 s: the big one, killed at 300 s when it starts last, finishes the next run', async () => {
    // The rules of the daily jobs: no start after 240 s, killed at 300 s, the
    // attempt stamped as it starts. Without retryFirstOnce the big one, last
    // by its start stamp, is killed on every run, forever.
    vi.useFakeTimers({ toFake: ['Date'] });
    const table = cronAttemptsTable();
    const stub = makeSupabaseStub(table.results);
    const small = ids(40);
    const BIG = 'zz-big';
    const outcomes: Array<{ completed: string[]; killed: string[] }> = [];
    for (let day = 0; day < 4; day += 1) {
      const runStart = Date.parse('2026-11-17T08:00:00.000Z') + day * DAY;
      vi.setSystemTime(runStart);
      const completed: string[] = [];
      const killed: string[] = [];
      let dead = false;
      await sweepOrganizations(
        stub.client,
        {
          job: 'auto_reorder',
          tag: 'cron.test',
          orgIds: [...small, BIG],
          deadlineAt: runStart + 240_000,
          slotMs: DAY,
          holdMs: 20 * 60 * 60_000,
          stopWhen: () => dead,
        },
        async (orgId) => {
          const took = orgId === BIG ? 150_000 : 4_000;
          if (Date.now() + took > runStart + 300_000) {
            // maxDuration: the function is killed with this one in flight.
            // Nothing after the stamp is written, as in a real kill.
            dead = true;
            killed.push(orgId);
            throw new KilledRun();
          }
          vi.setSystemTime(Date.now() + took);
          completed.push(orgId);
          return { result: 'success', value: null };
        },
      );
      // The sweep records a throw as a failure and writes nothing for it: the
      // row keeps the provisional count of the stamp, exactly a kill's row.
      outcomes.push({ completed, killed });
    }
    expect(outcomes[0]!.killed).toEqual([BIG]);
    expect(outcomes[1]!.completed[0]).toBe(BIG);
    expect(outcomes[1]!.killed).toEqual([]);
    // Afterwards it is not killed again, and every small one keeps being reached.
    expect(outcomes.slice(1).flatMap((o) => o.killed)).toEqual([]);
    const reached = new Set(outcomes.slice(1).flatMap((o) => o.completed));
    expect(reached.size).toBe(41);
  });
});

class KilledRun extends Error {}
