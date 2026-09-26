import { describe, expect, it } from 'vitest';

import { IdBatchReadError, type PageBuilder } from './id-batches';
import { PAGE_SIZE, fetchAllRows } from './paginate';

/**
 * The phone's fetchAllRows, the twin of the web's
 * (apps/web/src/server/services/lib/paginate.ts): 1000-row pages until a short
 * page, stopping at an optional ceiling, and THROWING on any failed page.
 */

/** A server holding `total` rows; every window it is asked for is recorded.
 *  Like PostgREST, it never answers more than max_rows for one request. */
function server(total: number, fail?: (from: number) => { message: string; status?: number } | Error | null) {
  const all = Array.from({ length: total }, (_, n) => ({ n }));
  const asked: [number, number][] = [];
  const build: PageBuilder<{ n: number }> = (from, to) => {
    asked.push([from, to]);
    const failure = fail?.(from) ?? null;
    if (failure instanceof Error) return Promise.reject(failure);
    if (failure) {
      return Promise.resolve({
        data: null,
        error: { message: failure.message },
        status: failure.status ?? 0,
        statusText: '',
      });
    }
    const end = Math.min(to, from + PAGE_SIZE - 1);
    return Promise.resolve({ data: all.slice(from, end + 1), error: null, status: 200, statusText: 'OK' });
  };
  return { build, asked };
}

describe('fetchAllRows (mobile)', () => {
  it('pages 1000 rows at a time until a short page, and returns every row in order', async () => {
    const { build, asked } = server(2345);
    const rows = await fetchAllRows(build);
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 2345 }, (_, n) => n));
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('an exact multiple of the page asks once more and stops at the empty page', async () => {
    const { build, asked } = server(2000);
    expect(await fetchAllRows(build)).toHaveLength(2000);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('a last page one row short of full (1,999 rows) is the last page: no extra request', async () => {
    const { build, asked } = server(1999);
    expect(await fetchAllRows(build)).toHaveLength(1999);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('a ceiling one past a page (1001) asks for a one-row last window and stops there', async () => {
    const { build, asked } = server(5000);
    const rows = await fetchAllRows(build, { cap: 1001 });
    expect(rows).toHaveLength(1001);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1000],
    ]);
  });

  it('stops at the ceiling: the last window is cut to it and nothing past it is asked for', async () => {
    const { build, asked } = server(5000);
    const rows = await fetchAllRows(build, { cap: 1500 });
    expect(rows).toHaveLength(1500);
    expect(rows.at(-1)).toEqual({ n: 1499 });
    expect(asked).toEqual([
      [0, 999],
      [1000, 1499],
    ]);
  });

  it('a ceiling on a page boundary makes no extra request', async () => {
    const { build, asked } = server(5000);
    expect(await fetchAllRows(build, { cap: 2000 })).toHaveLength(2000);
    expect(asked).toHaveLength(2);
  });

  it('a failed page AFTER the first throws; the first page never stands in for the list', async () => {
    const { build, asked } = server(2500, (from) => (from === 1000 ? { message: 'fetch failed', status: 503 } : null));
    const err = await fetchAllRows(build).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdBatchReadError);
    expect((err as IdBatchReadError).message).toBe('fetch failed');
    expect((err as IdBatchReadError).status).toBe(503);
    // It stopped at the failure: no page after it was asked for.
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('a failed first page throws too', async () => {
    const { build } = server(10, () => ({ message: 'permission denied' }));
    await expect(fetchAllRows(build)).rejects.toThrow('permission denied');
  });

  it('an empty gateway body still gives a reason, never an empty message', async () => {
    const { build } = server(1500, (from) => (from === 1000 ? { message: '', status: 502 } : null));
    await expect(fetchAllRows(build)).rejects.toThrow('HTTP 502');
  });

  it('a rejected request after the first page rejects the read', async () => {
    const { build } = server(2500, (from) => (from === 1000 ? new Error('Network request failed') : null));
    await expect(fetchAllRows(build)).rejects.toThrow('Network request failed');
  });

  it('an empty set is one request and no rows', async () => {
    const { build, asked } = server(0);
    expect(await fetchAllRows(build)).toEqual([]);
    expect(asked).toEqual([[0, 999]]);
  });
});
