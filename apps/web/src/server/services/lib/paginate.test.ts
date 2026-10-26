import { describe, expect, it, vi } from 'vitest';

import { ServiceError } from '../context';
import { fetchAllRows, fetchAllRowsConcurrently, PAGE_SIZE } from './paginate';

/**
 * Build a `buildPage(from, to)` that serves rows [0, total) from an in-memory
 * dataset, mirroring PostgREST: each page returns at most `to - from + 1` rows
 * and the `[api] max_rows = 1000` cap is irrelevant because the helper requests
 * PAGE_SIZE windows. Records every (from, to) it was asked for.
 */
function pagedSource(total: number) {
  const calls: Array<[number, number]> = [];
  const build = (from: number, to: number) => {
    calls.push([from, to]);
    const rows: Array<{ id: number }> = [];
    for (let i = from; i <= to && i < total; i += 1) rows.push({ id: i });
    return Promise.resolve({ data: rows, error: null as { message: string } | null });
  };
  return { build, calls };
}

describe('fetchAllRows', () => {
  it('returns a single short page without a second query', async () => {
    const src = pagedSource(250);
    const rows = await fetchAllRows(src.build);
    expect(rows).toHaveLength(250);
    expect(src.calls).toHaveLength(1);
    expect(src.calls[0]).toEqual([0, PAGE_SIZE - 1]);
  });

  it('loops across pages and assembles every row past the 1000 cap', async () => {
    const src = pagedSource(2300);
    const rows = await fetchAllRows<{ id: number }>(src.build);
    expect(rows).toHaveLength(2300);
    expect(rows[0]?.id).toBe(0);
    expect(rows[2299]?.id).toBe(2299);
    // 1000 + 1000 + 300 → three pages.
    expect(src.calls).toHaveLength(3);
    expect(src.calls[2]).toEqual([2000, 2999]);
  });

  it('stops at an exact page boundary (full last page then a short empty page)', async () => {
    const src = pagedSource(2000);
    const rows = await fetchAllRows(src.build);
    expect(rows).toHaveLength(2000);
    // Two full pages return PAGE_SIZE rows each, so the loop probes a third
    // (empty) page to learn it has reached the end.
    expect(src.calls).toHaveLength(3);
  });

  it('honors a cap smaller than the dataset and never over-fetches', async () => {
    const src = pagedSource(5000);
    const rows = await fetchAllRows(src.build, { cap: 2000 });
    expect(rows).toHaveLength(2000);
    // Two pages of 1000, then stop at the cap — no third query.
    expect(src.calls).toHaveLength(2);
    expect(src.calls[1]).toEqual([1000, 1999]);
  });

  it('caps a partial final window to the cap boundary', async () => {
    const src = pagedSource(5000);
    const rows = await fetchAllRows(src.build, { cap: 1500 });
    expect(rows).toHaveLength(1500);
    // Second window is clamped to [1000, 1499] (not [1000, 1999]).
    expect(src.calls[1]).toEqual([1000, 1499]);
  });

  it('throws a ServiceError when a page reports an error', async () => {
    const build = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    // internal_error messages are sanitized (S13): the public message is
    // generic and the raw detail is retained on internalDetail.
    await expect(fetchAllRows(build)).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'boom',
    });
  });
});

describe('fetchAllRows error detail', () => {
  it('keeps the PostgREST message as the internal detail', async () => {
    const err = await fetchAllRows(async () => ({
      data: null,
      error: { message: 'relation "x" does not exist' },
      status: 404,
      statusText: 'Not Found',
    })).catch((e: unknown) => e as ServiceError);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).internalDetail).toBe('relation "x" does not exist');
  });

  it('names the status when an empty 502 body leaves the message empty', async () => {
    // Before: internalDetail was undefined, so the set-rack log said only
    // "An internal error occurred" for a gateway that was dropping requests.
    const err = await fetchAllRows(async () => ({
      data: null,
      error: { message: '' },
      status: 502,
      statusText: 'Bad Gateway',
    })).catch((e: unknown) => e as ServiceError);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect((err as ServiceError).internalDetail).toBe('HTTP 502 Bad Gateway (empty error message)');
    expect((err as ServiceError).message).not.toContain('502');
  });
});

/**
 * fetchAllRowsConcurrently (B25): the same pages as fetchAllRows, but the
 * pages after the first are sent together. A source whose every page waits
 * until the test releases it shows what is in flight at once.
 */
function heldSource(total: { now: number }, opts: { count?: boolean } = {}) {
  const asked: Array<{ from: number; to: number; withCount: boolean }> = [];
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const build = (from: number, to: number, withCount: boolean) => {
    asked.push({ from, to, withCount });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<{ data: Array<{ id: number }>; error: null; count: number | null }>(
      (resolve) => {
        waiting.push(() => {
          inFlight -= 1;
          const rows: Array<{ id: number }> = [];
          for (let i = from; i <= to && i < total.now; i += 1) rows.push({ id: i });
          resolve({
            data: rows,
            error: null,
            count: withCount && opts.count !== false ? total.now : null,
          });
        });
      },
    );
  };
  /** Answer every page sent so far; resolves once their answers are handled. */
  const answerAll = async () => {
    const now = waiting.splice(0);
    for (const answer of now) answer();
    await new Promise((r) => setTimeout(r, 0));
    return now.length;
  };
  return { build, asked, answerAll, maxInFlight: () => maxInFlight };
}

/** Answer page waves until the read settles; the number of waves it took. */
async function drain<T>(read: Promise<T>, src: ReturnType<typeof heldSource>) {
  let done = false;
  void read.finally(() => {
    done = true;
  });
  const waves: number[] = [];
  while (!done) {
    await new Promise((r) => setTimeout(r, 0));
    if (done) break;
    waves.push(await src.answerAll());
  }
  return { rows: await read, waves: waves.filter((n) => n > 0) };
}

describe('fetchAllRowsConcurrently', () => {
  it('one short page: one request, which asks for the count', async () => {
    const src = heldSource({ now: 250 });
    const { rows, waves } = await drain(fetchAllRowsConcurrently(src.build), src);
    expect(rows).toHaveLength(250);
    expect(waves).toEqual([1]);
    expect(src.asked).toEqual([{ from: 0, to: PAGE_SIZE - 1, withCount: true }]);
  });

  it('every page after the first goes out together: 5,500 rows in two waves, not six', async () => {
    const src = heldSource({ now: 5500 });
    const { rows, waves } = await drain(fetchAllRowsConcurrently(src.build), src);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 5500 }, (_, i) => i));
    // The first page, then the five the count says remain, at once.
    expect(waves).toEqual([1, 5]);
    expect(src.asked.filter((a) => a.withCount)).toHaveLength(1);
    expect(src.asked.map((a) => a.from)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });

  it('never more than `concurrency` pages in flight', async () => {
    const src = heldSource({ now: 9500 });
    const { rows } = await drain(fetchAllRowsConcurrently(src.build, { concurrency: 3 }), src);
    expect(rows).toHaveLength(9500);
    expect(src.maxInFlight()).toBe(3);
  });

  it('rows added after the count are still read, a page at a time past the counted ones', async () => {
    const total = { now: 2000 };
    const src = heldSource(total);
    const read = fetchAllRowsConcurrently<{ id: number }>(src.build);
    await new Promise((r) => setTimeout(r, 0));
    await src.answerAll(); // the first page counts 2,000
    total.now = 2300; // 300 more land before the second page answers
    const { rows } = await drain(read, src);
    expect(rows).toHaveLength(2300);
    expect(src.asked.map((a) => a.from)).toEqual([0, 1000, 2000]);
  });

  it('a page that answers without a count reads on one page at a time, as fetchAllRows does', async () => {
    const src = heldSource({ now: 2300 }, { count: false });
    const { rows, waves } = await drain(fetchAllRowsConcurrently(src.build), src);
    expect(rows).toHaveLength(2300);
    expect(waves).toEqual([1, 1, 1]);
  });

  it('a failed page throws the same ServiceError as fetchAllRows', async () => {
    const build = vi.fn(async (from: number) =>
      from === 0
        ? {
            data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })),
            error: null,
            count: 3000,
          }
        : { data: null, error: { message: 'boom' } },
    );
    await expect(fetchAllRowsConcurrently(build)).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: 'boom',
    });
  });
});
