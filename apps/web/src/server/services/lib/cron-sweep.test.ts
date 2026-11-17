import { afterEach, describe, expect, it, vi } from 'vitest';

import { newestPerKey, oldestFirst, rotatingWindow, sweepUntilDeadline } from './cron-sweep';

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
