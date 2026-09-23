import { describe, expect, it } from 'vitest';

import {
  chunkInFilterValues,
  encodedInValueLength,
  IN_FILTER_MAX_ENCODED_CHARS,
  IN_FILTER_MAX_VALUES,
  mapWithConcurrency,
} from './in-filter';

function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

/** What postgrest-js actually appends for `.in(col, values)`: dedupe, quote
 *  values holding `,()`, join with `,`, serialize with URLSearchParams. */
function realInParamLength(values: string[]): number {
  const cleaned = Array.from(new Set(values))
    .map((s) => (/[,()]/.test(s) ? `"${s}"` : s))
    .join(',');
  const params = new URLSearchParams();
  params.append('c', `in.(${cleaned})`);
  // Strip "c=in.%28" and "%29" so the figure is the values plus separators.
  return params.toString().length - 'c=in.%28'.length - '%29'.length;
}

function batchChars(batch: Array<string | number>): number {
  return batch.reduce<number>((sum, v) => sum + encodedInValueLength(v) + 3, 0);
}

describe('encodedInValueLength', () => {
  it('matches the length postgrest-js adds for a plain uuid', () => {
    expect(encodedInValueLength(uuid(1))).toBe(36);
    expect(encodedInValueLength(uuid(1))).toBe(realInParamLength([uuid(1)]));
  });

  it('counts the quotes and percent-encoding of a value holding a reserved character', () => {
    const v = 'SN,1 (a)%';
    expect(encodedInValueLength(v)).toBe(realInParamLength([v]));
    // "SN,1 (a)%" -> %22SN%2C1+%28a%29%25%22
    expect(encodedInValueLength(v)).toBe('%22SN%2C1+%28a%29%25%22'.length);
  });

  it('measures a number as its decimal text', () => {
    expect(encodedInValueLength(12345)).toBe(5);
  });

  it('agrees with the real serializer across a whole batch', () => {
    const values = Array.from({ length: 100 }, (_, i) => uuid(i));
    // The helper charges one separator per value; the real list has one fewer.
    expect(batchChars(values) - 3).toBe(realInParamLength(values));
    expect(realInParamLength(values)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
  });
});

describe('chunkInFilterValues', () => {
  it('splits 250 uuids into batches of 100, 100 and 50', () => {
    const batches = chunkInFilterValues(Array.from({ length: 250 }, (_, i) => uuid(i)));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(IN_FILTER_MAX_VALUES).toBe(100);
  });

  it('dedupes keeping first-seen order and drops null and undefined', () => {
    const batches = chunkInFilterValues(['b', 'a', null, 'b', undefined, 'c', 'a']);
    expect(batches).toEqual([['b', 'a', 'c']]);
  });

  it('returns no batches for an empty or all-null list', () => {
    expect(chunkInFilterValues([])).toEqual([]);
    expect(chunkInFilterValues([null, undefined])).toEqual([]);
  });

  it('keeps every batch of long, quoted, percent-heavy strings inside the character budget', () => {
    // 128-character serials carrying `,` (quoted) and `%` (encoded as %25).
    const serials = Array.from({ length: 60 }, (_, i) =>
      `${String(i).padStart(4, '0')},%%(${'x'.repeat(120)})`.slice(0, 128),
    );
    const batches = chunkInFilterValues(serials);
    expect(batches.flat()).toEqual(serials);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(batchChars(b)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
      expect(realInParamLength(b)).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
    }
  });

  it('packs to the budget, not below it', () => {
    // 60-char plain values cost 63 each: 63 per batch of 4000 -> 63 values.
    const values = Array.from(
      { length: 130 },
      (_, i) => `${String(i).padStart(3, '0')}${'v'.repeat(57)}`,
    );
    const batches = chunkInFilterValues(values);
    expect(batches.map((b) => b.length)).toEqual([63, 63, 4]);
  });

  it('sends a single value longer than the budget alone, never split and never dropped', () => {
    const huge = 'h'.repeat(IN_FILTER_MAX_ENCODED_CHARS + 50);
    const batches = chunkInFilterValues(['a', huge, 'b']);
    expect(batches).toEqual([['a'], [huge], ['b']]);
  });

  it('honours explicit caps', () => {
    const batches = chunkInFilterValues(
      Array.from({ length: 10 }, (_, i) => uuid(i)),
      { maxValues: 4 },
    );
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
    const byChars = chunkInFilterValues(
      Array.from({ length: 10 }, (_, i) => uuid(i)),
      { maxEncodedChars: 39 * 3 },
    );
    expect(byChars.map((b) => b.length)).toEqual([3, 3, 3, 1]);
  });
});

describe('mapWithConcurrency', () => {
  function deferredRunner(limitCheck: { inFlight: number; peak: number }) {
    return async (n: number) => {
      limitCheck.inFlight += 1;
      limitCheck.peak = Math.max(limitCheck.peak, limitCheck.inFlight);
      await new Promise((r) => setTimeout(r, 1 + (n % 3)));
      limitCheck.inFlight -= 1;
      return n * 2;
    };
  }

  it('never has more than the limit in flight and keeps input order', async () => {
    const track = { inFlight: 0, peak: 0 };
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 6, deferredRunner(track));
    expect(out).toEqual(items.map((i) => i * 2));
    expect(track.peak).toBe(6);
  });

  it('returns [] for no items without calling fn', async () => {
    let called = 0;
    const out = await mapWithConcurrency([], 6, async () => {
      called += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it('starts nothing new after a rejection, awaits the calls in flight, and rethrows the first error', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);
    const run = mapWithConcurrency(items, 2, async (n) => {
      started.push(n);
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error('first');
      }
      if (n === 2) {
        await new Promise((r) => setTimeout(r, 5));
        finished.push(n);
        throw new Error('second');
      }
      await new Promise((r) => setTimeout(r, 3));
      finished.push(n);
      return n;
    });
    await expect(run).rejects.toThrow('first');
    // 0 and 1 start together; 1 fails; 0 was in flight and still settles.
    // Nothing past the failure's wave starts.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });
});
