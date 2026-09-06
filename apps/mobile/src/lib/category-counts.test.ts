import { describe, expect, it, vi } from 'vitest';

import {
  CATEGORY_COUNT_PAGE_SIZE,
  MAX_CATEGORY_COUNT_PAGES,
  countItemsByCategory,
  type CategoryCountsClient,
} from './category-counts';

/**
 * SP-072. The mobile Categories screen tallied items per category from ONE
 * bare `.select('category_id')` over the whole org. PostgREST clamps any
 * response to `[api] max_rows = 1000` (supabase/config.toml) with NO error and
 * NO marker, so above 1000 live items the per-category badges silently
 * undercount and any category whose rows fell past the cap shows 0.
 *
 * The fake client below models that clamp exactly: awaiting the builder
 * WITHOUT a `.range()` yields at most CATEGORY_COUNT_PAGE_SIZE rows, the same
 * way the server does. Same class as SP-032 (cycle-count lines).
 */

type Row = { category_id: string | null };

/**
 * A fake PostgREST chain. The tail of the chain is a thenable — exactly like a
 * real supabase-js builder — so the pre-fix "just await it" code path is
 * exercised and gets a silently clamped first window, while the fixed code
 * walks `.order('id').range(from, to)` windows.
 */
function fakeClient(pages: { data: Row[] | null; error: { message: string } | null }[]) {
  const ranges: [number, number][] = [];
  const seen = {
    table: '',
    columns: '',
    eq: ['', ''] as [string, string],
    is: ['', null as unknown] as [string, unknown],
    order: ['', {}] as [string, unknown],
    unranged: false,
  };
  let call = 0;
  const nextPage = () => pages[call++] ?? { data: [], error: null };

  const query = {
    order(column: string, opts?: { ascending?: boolean }) {
      seen.order = [column, opts];
      return query;
    },
    range(from: number, to: number) {
      ranges.push([from, to]);
      return Promise.resolve(nextPage());
    },
    // The server-side max_rows clamp, modelled: an unranged read returns the
    // FIRST window only, with no error and no way to tell it was truncated.
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      seen.unranged = true;
      const page = nextPage();
      const clamped = page.data ? page.data.slice(0, CATEGORY_COUNT_PAGE_SIZE) : page.data;
      return Promise.resolve({ data: clamped, error: page.error }).then(resolve, reject);
    },
  };

  const client: CategoryCountsClient = {
    from(table: string) {
      seen.table = table;
      return {
        select(columns: string) {
          seen.columns = columns;
          return {
            eq(column: string, value: string) {
              seen.eq = [column, value];
              return {
                is(col: string, value2: unknown) {
                  seen.is = [col, value2];
                  return query;
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, ranges, seen };
}

function rows(n: number, categoryId: string | null): Row[] {
  return Array.from({ length: n }, () => ({ category_id: categoryId }));
}

describe('countItemsByCategory', () => {
  it('pages past the 1000-row PostgREST cap so no category is undercounted', async () => {
    const { client, ranges, seen } = fakeClient([
      { data: rows(CATEGORY_COUNT_PAGE_SIZE, 'cat-a'), error: null },
      { data: rows(200, 'cat-b'), error: null },
    ]);

    const { data, error } = await countItemsByCategory(client, 'org-1');

    expect(error).toBeNull();
    expect(data?.get('cat-a')).toBe(1000);
    // Pre-fix this is undefined: cat-b's rows lived past the silent cap.
    expect(data?.get('cat-b')).toBe(200);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(seen.unranged).toBe(false);
  });

  it('stops after one request when the first window is short', async () => {
    const { client, ranges } = fakeClient([{ data: rows(12, 'cat-a'), error: null }]);
    const { data } = await countItemsByCategory(client, 'org-1');
    expect(data?.get('cat-a')).toBe(12);
    expect(ranges).toEqual([[0, 999]]);
  });

  it('scopes to the org, excludes deleted rows and sorts by id', async () => {
    const { client, seen } = fakeClient([{ data: [], error: null }]);
    await countItemsByCategory(client, 'org-42');
    expect(seen.table).toBe('inventory_items');
    expect(seen.columns).toBe('category_id');
    expect(seen.eq).toEqual(['organization_id', 'org-42']);
    expect(seen.is).toEqual(['deleted_at', null]);
    // A stable order is REQUIRED or a row can land on two windows (or none).
    expect(seen.order).toEqual(['id', { ascending: true }]);
  });

  it('counts uncategorised rows toward nothing', async () => {
    const { client } = fakeClient([
      { data: [...rows(3, 'cat-a'), ...rows(5, null)], error: null },
    ]);
    const { data } = await countItemsByCategory(client, 'org-1');
    expect(data?.get('cat-a')).toBe(3);
    expect(data?.size).toBe(1);
  });

  it('fails CLOSED on a window error — never returns a partial tally', async () => {
    const { client } = fakeClient([
      { data: rows(CATEGORY_COUNT_PAGE_SIZE, 'cat-a'), error: null },
      { data: null, error: { message: 'permission denied' } },
    ]);
    const { data, error } = await countItemsByCategory(client, 'org-1');
    expect(data).toBeNull();
    expect(error?.message).toBe('permission denied');
  });

  it('refuses (rather than truncates) an org beyond the page ceiling', async () => {
    const pages = Array.from({ length: MAX_CATEGORY_COUNT_PAGES + 1 }, () => ({
      data: rows(CATEGORY_COUNT_PAGE_SIZE, 'cat-a'),
      error: null,
    }));
    const { client, ranges } = fakeClient(pages);
    const { data, error } = await countItemsByCategory(client, 'org-1');
    expect(data).toBeNull();
    expect(error?.message).toMatch(/too many items/i);
    expect(ranges).toHaveLength(MAX_CATEGORY_COUNT_PAGES);
  });

  it('treats a null data window as empty instead of throwing', async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    const { data, error } = await countItemsByCategory(client, 'org-1');
    expect(error).toBeNull();
    expect(data?.size).toBe(0);
  });

  it('does not swallow a rejected window promise silently', async () => {
    const boom = vi.fn(() => Promise.reject(new Error('network down')));
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({ is: () => ({ order: () => ({ range: boom }) }) }),
        }),
      }),
    } as unknown as CategoryCountsClient;
    await expect(countItemsByCategory(client, 'org-1')).rejects.toThrow('network down');
  });
});
