import { describe, expect, it } from 'vitest';

import { ServiceError } from '../context';
import {
  fetchAllRowsByIds,
  mapIdBatches,
  rawErrorText,
  settleAsDataError,
  writeInIdBatches,
} from './fetch-by-ids';
import { PAGE_SIZE } from './paginate';

function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

describe('fetchAllRowsByIds', () => {
  it('reads 250 ids in three batches of at most 100 and returns every row', async () => {
    const batches: string[][] = [];
    const rows = await fetchAllRowsByIds<{ id: string }>(ids(250), (batch) => {
      batches.push(batch);
      return async () => ({ data: batch.map((id) => ({ id })), error: null });
    });
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(rows.map((r) => r.id)).toEqual(ids(250));
  });

  it('pages a batch whose rows pass the 1000-row cap', async () => {
    const ranges: Array<[number, number]> = [];
    const rows = await fetchAllRowsByIds<{ n: number }>(ids(3), () => async (from, to) => {
      ranges.push([from, to]);
      const all = Array.from({ length: 1500 }, (_, n) => ({ n }));
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
    ]);
    expect(rows).toHaveLength(1500);
  });

  it('throws a ServiceError carrying the raw text when any batch fails', async () => {
    const run = fetchAllRowsByIds(ids(250), (batch) => async () => {
      if (batch[0] === uuid(100)) return { data: null, error: { message: 'raw: URI too long' } };
      return { data: [], error: null };
    });
    await expect(run).rejects.toBeInstanceOf(ServiceError);
    const err = (await run.catch((e: unknown) => e)) as ServiceError;
    expect(err.code).toBe('internal_error');
    expect(err.internalDetail).toBe('raw: URI too long');
    // The public message never carries the raw PostgREST text.
    expect(err.message).not.toContain('URI');
  });

  it('makes no request for an empty or all-null list', async () => {
    let calls = 0;
    const rows = await fetchAllRowsByIds([null, undefined], () => {
      calls += 1;
      return async () => ({ data: [], error: null });
    });
    expect(rows).toEqual([]);
    expect(calls).toBe(0);
  });

  it('runs at most six batches at once by default and honours a higher concurrency', async () => {
    async function peakFor(concurrency?: number) {
      let inFlight = 0;
      let peak = 0;
      await fetchAllRowsByIds(
        ids(2000),
        () => async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight -= 1;
          return { data: [], error: null };
        },
        concurrency ? { concurrency } : {},
      );
      return peak;
    }
    expect(await peakFor()).toBe(6);
    expect(await peakFor(20)).toBe(20);
  });
});

describe('mapIdBatches', () => {
  it('runs per batch and returns results in batch order', async () => {
    const out = await mapIdBatches(ids(250), async (batch) => batch.length);
    expect(out).toEqual([100, 100, 50]);
  });
});

describe('writeInIdBatches', () => {
  it('writes one batch at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await writeInIdBatches(ids(350), async (batch) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(peak).toBe(1);
    expect(res.written).toHaveLength(350);
    expect(res.rows).toHaveLength(350);
    expect(res.notWritten).toEqual([]);
    expect(res.error).toBeNull();
  });

  it('stops at the first failure by default and reports the failed batch and every later one', async () => {
    const seen: number[] = [];
    const res = await writeInIdBatches(ids(350), async (batch) => {
      seen.push(seen.length);
      if (seen.length === 2) return { error: { message: 'raw failure' } };
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(seen).toHaveLength(2);
    expect(res.written).toEqual(ids(100));
    expect(res.rows).toHaveLength(100);
    expect(res.notWritten).toEqual(ids(350).slice(100));
    expect(res.error).toBe('raw failure');
  });

  it('attempts every batch when stopOnError is false', async () => {
    let n = 0;
    const res = await writeInIdBatches(
      ids(350),
      async () => {
        n += 1;
        return n === 2 ? { error: { message: 'second' } } : { error: null };
      },
      { stopOnError: false },
    );
    expect(n).toBe(4);
    expect(res.written).toEqual([...ids(100), ...ids(350).slice(200)]);
    expect(res.notWritten).toEqual(ids(200).slice(100));
    expect(res.error).toBe('second');
  });

  it('treats a rejected request as a failed batch instead of throwing', async () => {
    const res = await writeInIdBatches(ids(150), async () => {
      throw new TypeError('fetch failed');
    });
    expect(res.written).toEqual([]);
    expect(res.notWritten).toHaveLength(150);
    expect(res.error).toBe('fetch failed');
  });
});

describe('rawErrorText and settleAsDataError', () => {
  it('prefers a ServiceError internal detail over its generic message', () => {
    expect(rawErrorText(new ServiceError('internal_error', 'raw pg text'))).toBe('raw pg text');
    expect(rawErrorText(new Error('plain'))).toBe('plain');
    expect(rawErrorText('str')).toBe('str');
  });

  it('adapts a throwing read to the { data, error } shape', async () => {
    expect(await settleAsDataError(Promise.resolve([1, 2]))).toEqual({ data: [1, 2], error: null });
    expect(
      await settleAsDataError(Promise.reject(new ServiceError('internal_error', 'boom'))),
    ).toEqual({ data: null, error: { message: 'boom' } });
  });
});
