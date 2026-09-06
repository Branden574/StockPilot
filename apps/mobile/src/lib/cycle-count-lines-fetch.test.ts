import { describe, expect, it, vi } from 'vitest';

import {
  CYCLE_COUNT_LINES_PAGE_SIZE,
  CYCLE_COUNT_LINES_SELECT,
  MAX_CYCLE_COUNT_LINE_PAGES,
  fetchAllCycleCountLines,
  type CycleCountLinesClient,
} from './cycle-count-lines-fetch';

/**
 * SP-032. The mobile cycle-count detail read used ONE bare `.select()`, which
 * PostgREST silently clamps to `[api] max_rows = 1000` — a 1,400-line count
 * showed 1,000 lines on the phone and the other 400 were uncountable AND were
 * written to the offline cache in that truncated state. The web detail had the
 * identical bug and fixed it in 0226. These tests pin the paging loop.
 */

type Row = Record<string, unknown>;

/** A fake PostgREST chain that records the windows asked for. */
function fakeClient(pages: { data: Row[] | null; error: { message: string } | null }[]) {
  const ranges: [number, number][] = [];
  const seen = { table: '', columns: '', eq: ['', ''] as [string, string], order: ['', {}] as [string, unknown] };
  let call = 0;
  const query = {
    order(column: string, opts?: { ascending?: boolean }) {
      seen.order = [column, opts];
      return query;
    },
    range(from: number, to: number) {
      ranges.push([from, to]);
      const page = pages[call++] ?? { data: [], error: null };
      return Promise.resolve(page);
    },
  };
  const client: CycleCountLinesClient = {
    from(table: string) {
      seen.table = table;
      return {
        select(columns: string) {
          seen.columns = columns;
          return {
            eq(column: string, value: string) {
              seen.eq = [column, value];
              return query;
            },
          };
        },
      };
    },
  };
  return { client, ranges, seen };
}

function rows(n: number, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `line-${offset + i}` }));
}

describe('fetchAllCycleCountLines', () => {
  it('pages past the 1000-row PostgREST cap and returns every line', async () => {
    const { client, ranges } = fakeClient([
      { data: rows(CYCLE_COUNT_LINES_PAGE_SIZE), error: null },
      { data: rows(401, 1000), error: null },
    ]);

    const { data, error } = await fetchAllCycleCountLines(client, 'cc-1');

    expect(error).toBeNull();
    expect(data).toHaveLength(1401);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('stops after one request when the first page is short', async () => {
    const { client, ranges } = fakeClient([{ data: rows(12), error: null }]);
    const { data } = await fetchAllCycleCountLines(client, 'cc-1');
    expect(data).toHaveLength(12);
    expect(ranges).toEqual([[0, 999]]);
  });

  it('filters by cycle_count_id, sorts by id and selects the variant columns', async () => {
    const { client, seen } = fakeClient([{ data: [], error: null }]);
    await fetchAllCycleCountLines(client, 'cc-42');
    expect(seen.table).toBe('cycle_count_lines');
    expect(seen.eq).toEqual(['cycle_count_id', 'cc-42']);
    // A stable order is REQUIRED or a row can land on two windows (or none).
    expect(seen.order).toEqual(['id', { ascending: true }]);
    expect(seen.columns).toBe(CYCLE_COUNT_LINES_SELECT);
    expect(seen.columns).toContain('variant_size');
    expect(seen.columns).toContain('jersey_number');
  });

  it('fails CLOSED on a page error — never returns a partial count', async () => {
    const { client } = fakeClient([
      { data: rows(CYCLE_COUNT_LINES_PAGE_SIZE), error: null },
      { data: null, error: { message: 'column does not exist' } },
    ]);
    const { data, error } = await fetchAllCycleCountLines(client, 'cc-1');
    expect(data).toBeNull();
    expect(error?.message).toBe('column does not exist');
  });

  it('refuses (rather than truncates) a count beyond the page ceiling', async () => {
    const pages = Array.from({ length: MAX_CYCLE_COUNT_LINE_PAGES + 1 }, () => ({
      data: rows(CYCLE_COUNT_LINES_PAGE_SIZE),
      error: null,
    }));
    const { client, ranges } = fakeClient(pages);
    const { data, error } = await fetchAllCycleCountLines(client, 'cc-1');
    expect(data).toBeNull();
    expect(error?.message).toMatch(/too large/i);
    expect(ranges).toHaveLength(MAX_CYCLE_COUNT_LINE_PAGES);
  });

  it('treats a null data page as empty instead of throwing', async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    const { data, error } = await fetchAllCycleCountLines(client, 'cc-1');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('does not swallow a rejected page promise silently', async () => {
    const boom = vi.fn(() => Promise.reject(new Error('network down')));
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => ({ range: boom }) }),
        }),
      }),
    } as unknown as CycleCountLinesClient;
    await expect(fetchAllCycleCountLines(client, 'cc-1')).rejects.toThrow('network down');
  });
});
