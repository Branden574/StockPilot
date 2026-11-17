import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  cronAttemptRecorder,
  newestPerKey,
  oldestFirst,
  readCronAttempts,
  rotatingWindow,
  sweepUntilDeadline,
} from './cron-sweep';

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

describe('rotatingWindow', () => {
  it('with N at or under the size, every slot is every id in order', () => {
    for (const slot of [0, 1, 7, 123_456]) {
      expect(rotatingWindow(ids(48), 48, slot)).toEqual(ids(48));
      expect(rotatingWindow(ids(3), 48, slot)).toEqual(ids(3));
    }
    expect(rotatingWindow([], 48, 5)).toEqual([]);
  });

  it('consecutive slots take consecutive stretches, and wrap around', () => {
    const all = ids(100);
    expect(rotatingWindow(all, 48, 0)).toEqual(all.slice(0, 48));
    expect(rotatingWindow(all, 48, 1)).toEqual(all.slice(48, 96));
    // Slot 2 starts at 96 and wraps to the start.
    expect(rotatingWindow(all, 48, 2)).toEqual([...all.slice(96), ...all.slice(0, 44)]);
  });

  it('any ceil(N / size) consecutive slots cover every id, for many N and start slots', () => {
    for (const n of [49, 50, 95, 96, 97, 100, 143, 500, 1001]) {
      const all = ids(n);
      const runs = Math.ceil(n / 48);
      for (const first of [0, 1, 5, 984_321]) {
        const seen = new Set<string>();
        for (let s = first; s < first + runs; s += 1) {
          const w = rotatingWindow(all, 48, s);
          expect(w).toHaveLength(48);
          expect(new Set(w).size).toBe(48);
          for (const id of w) seen.add(id);
        }
        expect(seen.size, `N=${n} from slot ${first}`).toBe(n);
      }
    }
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

describe('cron attempts (cron_sweep_attempts, 0492)', () => {
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

  it('stamps on start, then counts failures in a row: failure adds one, success resets, neither leaves it', async () => {
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
      ['f', undefined],
      ['f', 3],
      ['s', undefined],
      ['s', 0],
      ['n', undefined],
      ['new', undefined],
    ]);
    expect(new Set(rows.map((r) => r.job))).toEqual(new Set(['exception_sync']));
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
