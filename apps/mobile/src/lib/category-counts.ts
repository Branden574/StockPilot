/**
 * Per-category item tally for the mobile Categories screen (SP-072).
 *
 * WHY THIS EXISTS. The screen used to count items with ONE bare
 * `supabase.from('inventory_items').select('category_id')` over the whole org
 * and tally the rows in JS. PostgREST clamps any response to
 * `[api] max_rows = 1000` (supabase/config.toml) with NO error and NO marker,
 * so above 1000 live items the badges silently undercounted: the visible
 * numbers summed to exactly 1000, and any category whose rows sorted past the
 * cap displayed `0` next to a category that plainly has stock. Recurring
 * pattern #3 ("every aggregation SELECT must PAGINATE") — the same class as
 * SP-032 (mobile cycle-count lines) and the web fetchAllRows helper in
 * apps/web/src/server/services/lib/paginate.ts, which is `server-only` and so
 * cannot be imported here; this is the same loop, re-stated for the phone.
 *
 * Kept in src/lib (not inline in the screen) so it is unit-testable: vitest
 * compiles src/**\/*.test.ts only, never app/ or screens that import native
 * modules at top level.
 */

/** PostgREST's hard per-response row ceiling — keep equal to `[api] max_rows`. */
export const CATEGORY_COUNT_PAGE_SIZE = 1000;

/**
 * Windows we will ever ask for (50,000 items). An unbounded `for(;;)` would
 * spin forever against a server that ignored `.range()`, and a phone should
 * not make hundreds of round trips to decorate a badge. Hitting this REFUSES
 * the tally (see below) instead of returning a short one — a silent cap is the
 * exact bug this file removes (recurring pattern #7).
 */
export const MAX_CATEGORY_COUNT_PAGES = 50;

/** Minimal shape of a PostgREST query awaited to `{ data, error }`. */
interface PageResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

export interface CategoryCountsQuery {
  order(column: string, opts?: { ascending?: boolean }): CategoryCountsQuery;
  range(from: number, to: number): PromiseLike<PageResult>;
}

/** The `.select(...).eq(...).is(...)` head of the chain, re-narrowed inside. */
interface CategoryCountsTable {
  select(columns: string): {
    eq(column: string, value: string): {
      is(column: string, value: null): CategoryCountsQuery;
    };
  };
}

/**
 * Structural slice of the Supabase client this helper needs. `from` returns
 * `unknown` ON PURPOSE (same reason as cycle-count-lines-fetch.ts): spelling
 * the real PostgREST builder makes TS instantiate its select-string parser at
 * the call site. The chain is re-narrowed to CategoryCountsTable below and the
 * tests exercise the real shape.
 */
export interface CategoryCountsClient {
  from(table: string): unknown;
}

/**
 * Counts live items per category for one org, in 1000-row windows.
 *
 * Returns a `{ data, error }` envelope like a single Supabase call would.
 * It fails CLOSED: a failed or over-long read returns `data: null` rather than
 * the rows accumulated so far, because a PARTIAL tally rendered as a whole one
 * is precisely the failure this replaces. The caller renders "unknown" for
 * every badge in that case — never a plausible-looking wrong number.
 *
 * The stable `.order('id')` is REQUIRED — without a deterministic sort the
 * same row can land in two windows, or in none.
 */
export async function countItemsByCategory(
  client: CategoryCountsClient,
  orgId: string,
): Promise<{ data: Map<string, number> | null; error: { message: string } | null }> {
  const byCat = new Map<string, number>();

  for (let page = 0; page < MAX_CATEGORY_COUNT_PAGES; page++) {
    const from = page * CATEGORY_COUNT_PAGE_SIZE;
    const to = from + CATEGORY_COUNT_PAGE_SIZE - 1;
    const table = client.from('inventory_items') as CategoryCountsTable;
    const { data, error } = await table
      .select('category_id')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) return { data: null, error };

    const window = (data ?? []) as { category_id: string | null }[];
    for (const r of window) {
      // Uncategorised items belong to no badge; they are simply not tallied.
      if (r.category_id) byCat.set(r.category_id, (byCat.get(r.category_id) ?? 0) + 1);
    }

    // A short window is the end of the set — the only reliable signal, since
    // PostgREST reports no total unless asked for an exact count.
    if (window.length < CATEGORY_COUNT_PAGE_SIZE) return { data: byCat, error: null };
  }

  return {
    data: null,
    error: {
      message: `This organization has too many items to tally on the phone (over ${
        MAX_CATEGORY_COUNT_PAGES * CATEGORY_COUNT_PAGE_SIZE
      }). Category counts are shown on the web app.`,
    },
  };
}
