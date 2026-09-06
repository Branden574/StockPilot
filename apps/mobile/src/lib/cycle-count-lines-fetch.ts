/**
 * Paged read of a cycle count's lines (SP-032).
 *
 * WHY THIS EXISTS. The detail screen used to fetch every line with ONE bare
 * `.select()`. PostgREST clamps any response to `[api] max_rows = 1000`
 * (supabase/config.toml) with NO error and NO marker, so a count with more
 * than 1000 lines arrived silently truncated: the extra lines were invisible
 * on the phone, could not be scanned ("Not in this count"), were missing from
 * the "N lines not counted will be skipped" prompt, and — worst — were written
 * to the SQLite offline snapshot in that truncated state.
 *
 * The WEB detail page had exactly this bug and fixed it in migration 0226
 * ("A >1000-SKU count showed the counter only the first 1000 lines; the rest
 * were invisible and UNCOUNTABLE") with the cycle_count_lines_page function.
 * That function has no Bearer twin, so mobile pages the table directly here —
 * the same shape as apps/web/src/server/services/lib/paginate.ts fetchAllRows.
 *
 * Kept in src/lib (not inline in the screen) so it is unit-testable: vitest
 * compiles src/** only, never app/ screens.
 */

/** PostgREST's hard per-response row ceiling — keep equal to `[api] max_rows`. */
export const CYCLE_COUNT_LINES_PAGE_SIZE = 1000;

/**
 * Windows we will ever ask for. A count of 50,000 lines is not a thing anyone
 * counts on a phone, and an unbounded `for(;;)` would spin forever against a
 * server that ignored `.range()`. Hitting this REFUSES the read (see below)
 * rather than returning a short set — a silent cap is the very bug this file
 * exists to remove (recurring pattern #7).
 */
export const MAX_CYCLE_COUNT_LINE_PAGES = 50;

/**
 * The columns the detail screen maps. `variant_size` / `jersey_number` come
 * from 0298 (sports) and feed the shared `variantLabel` builder, so the phone,
 * the web row and the printed count sheet all name a variant identically.
 */
export const CYCLE_COUNT_LINES_SELECT = `id, expected_quantity, counted_quantity, counted_at, updated_at,
           item:inventory_items!item_id (id, name, sku, barcode, variant_size, jersey_number)`;

/** Minimal shape of a PostgREST query awaited to `{ data, error }`. */
interface PageResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

export interface CycleCountLinesQuery {
  order(column: string, opts?: { ascending?: boolean }): CycleCountLinesQuery;
  range(from: number, to: number): PromiseLike<PageResult>;
}

/** The `.select(...).eq(...)` head of the chain, re-narrowed inside. */
interface CycleCountLinesTable {
  select(columns: string): {
    eq(column: string, value: string): CycleCountLinesQuery;
  };
}

/**
 * Structural slice of the Supabase client this helper needs. `from` returns
 * `unknown` ON PURPOSE: spelling the real PostgREST builder here makes TS
 * instantiate its select-string parser against our embedded `item:...` select
 * and blow the recursion limit at the call site (TS2589 "Type instantiation is
 * excessively deep"). The chain is re-narrowed to CycleCountLinesTable below,
 * and the tests exercise the real shape.
 */
export interface CycleCountLinesClient {
  from(table: string): unknown;
}

export type CycleCountLineRow = Record<string, unknown>;

/**
 * Fetches EVERY line of a cycle count in 1000-row windows.
 *
 * Returns the same `{ data, error }` envelope a single Supabase call would, so
 * the caller's existing error branch is unchanged. It fails CLOSED: a failed
 * window discards the rows already accumulated and returns the error, because
 * a partial count rendered as a whole one is exactly the failure this replaces
 * (the screen shows its "Could not load this count" state instead).
 *
 * The stable `.order('id')` is REQUIRED — without a deterministic sort the same
 * row can land in two windows, or in none.
 */
export async function fetchAllCycleCountLines(
  client: CycleCountLinesClient,
  cycleCountId: string,
): Promise<{ data: CycleCountLineRow[] | null; error: { message: string } | null }> {
  const rows: CycleCountLineRow[] = [];

  for (let page = 0; page < MAX_CYCLE_COUNT_LINE_PAGES; page++) {
    const from = page * CYCLE_COUNT_LINES_PAGE_SIZE;
    const to = from + CYCLE_COUNT_LINES_PAGE_SIZE - 1;
    const table = client.from('cycle_count_lines') as CycleCountLinesTable;
    const { data, error } = await table
      .select(CYCLE_COUNT_LINES_SELECT)
      .eq('cycle_count_id', cycleCountId)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) return { data: null, error };

    const window = (data ?? []) as CycleCountLineRow[];
    for (const r of window) rows.push(r);
    // A short window is the end of the set — the only reliable signal, since
    // PostgREST reports no total unless asked for an exact count.
    if (window.length < CYCLE_COUNT_LINES_PAGE_SIZE) {
      return { data: rows, error: null };
    }
  }

  return {
    data: null,
    error: {
      message: `This count is too large to open on the phone (over ${
        MAX_CYCLE_COUNT_LINE_PAGES * CYCLE_COUNT_LINES_PAGE_SIZE
      } lines). Count it in smaller sessions, or use the web app.`,
    },
  };
}
