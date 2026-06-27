import { describe, expect, it, vi } from 'vitest';

import { fetchAllRows, PAGE_SIZE } from './paginate';

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
