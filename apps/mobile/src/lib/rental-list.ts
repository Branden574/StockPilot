/**
 * Which checkouts the phone's Rentals list reads (src/screens/rentals.tsx).
 *
 * It read the 100 newest rentals of every status in one request
 * (`.limit(100)`). Past 100 rentals, an older one still out was not on the
 * list at all, and the eyebrow's "N OUT · N OVERDUE", counted from the rows
 * read, left it out too: the rental most likely to be overdue was the one the
 * phone could not see (B32).
 *
 * Now two reads, both under the caller's own row level security as before:
 *   - every rental still out (status 'out'), in 1000-row pages to
 *     RENTAL_OPEN_ROW_CEILING (paginate.ts fetchAllRows), so the eyebrow's
 *     counts are exact;
 *   - the newest RENTAL_CLOSED_SHOWN returned or cancelled ones, with their
 *     exact count, so the list can say how many it does not show
 *     (rentalHistoryNote). The web Rentals page pages through all of them.
 * They are merged newest first, as the list always ordered them.
 *
 * THROWS IdBatchReadError when either read fails: the screen keeps the rows
 * it shows with a banner, or says "Could not load rentals.", and never shows
 * part of the list as the whole.
 *
 * Pure and platform-free (no React Native import, no Supabase client), so it
 * runs under vitest. Keep `.select` directly on `.from('rentals')`: apps/web's
 * inventory-list-invalidation guard scans mobile code too (id-batches.ts
 * idReadSelect).
 */

import {
  IdBatchReadError,
  readErrorMessage,
  type IdReadClient,
  type PageResult,
} from './id-batches';
import { fetchAllRows } from './paginate';
import { RENTAL_LIST_REMINDER_COLUMNS } from './rental-view';

/** Returned and cancelled rentals the list shows: the newest ones. */
export const RENTAL_CLOSED_SHOWN = 100;

/**
 * The most rentals still out the list reads. A safety ceiling, not a page
 * size: reaching it is logged, and the eyebrow's counts then end in "+".
 */
export const RENTAL_OPEN_ROW_CEILING = 10_000;

/** The list's columns: the card, the reminder mark, and the warehouse name. */
export const RENTAL_LIST_COLUMNS = `id, status, borrower_name, borrower_email, ${RENTAL_LIST_REMINDER_COLUMNS},
           checked_out_at, expected_return_at, returned_at, notes,
           warehouse:warehouses!warehouse_id (name)`;

/** A row as PostgREST answers it; the screen maps the rest of its columns. */
export type RentalListSource = Record<string, unknown> & {
  id: string;
  status: string;
  checked_out_at: string;
};

/** How far the list goes, for its eyebrow and its closing line. */
export interface RentalListExtent {
  /** Returned or cancelled rentals the list shows (the newest). */
  closedShown: number;
  /** How many returned or cancelled rentals the organization has, as far as
   *  the caller can read them. Null when the answer carried no count. */
  closedTotal: number | null;
  /** The rentals still out reached RENTAL_OPEN_ROW_CEILING: there may be more. */
  openCapped: boolean;
}

/** One read of the list. */
export interface RentalListRead {
  /** Every rental still out (to the ceiling) and the newest closed ones, newest first. */
  rows: RentalListSource[];
  extent: RentalListExtent;
}

interface RentalListChain {
  eq(column: string, value: unknown): RentalListChain;
  neq(column: string, value: unknown): RentalListChain;
  order(column: string, opts?: { ascending?: boolean }): RentalListChain;
  range(from: number, to: number): PromiseLike<RentalListPage>;
}

type RentalListPage = PageResult<RentalListSource> & { count?: number | null };

interface RentalListTable {
  select(columns: string, opts?: { count?: 'exact' }): RentalListChain;
}

/** The organization's rentals. Each read orders them newest first with `id`
 *  as the tiebreak, so a page boundary never repeats or skips a row. */
function rentalsOf(
  client: IdReadClient,
  orgId: string,
  opts?: { count?: 'exact' },
): RentalListChain {
  return (client.from('rentals') as RentalListTable)
    .select(RENTAL_LIST_COLUMNS, opts)
    .eq('organization_id', orgId);
}

function checkedOutMs(r: RentalListSource): number {
  const t = Date.parse(r.checked_out_at);
  return Number.isNaN(t) ? -Infinity : t;
}

/** The reads' own order (checked out, newest first, then `id` descending),
 *  so the two lists interleave as one. */
function newestFirst(a: RentalListSource, b: RentalListSource): number {
  const at = checkedOutMs(a);
  const bt = checkedOutMs(b);
  if (at !== bt) return at > bt ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/**
 * Every rental still out and the newest RENTAL_CLOSED_SHOWN closed ones, for
 * one organization. See the file header.
 */
export async function readRentalList(client: IdReadClient, orgId: string): Promise<RentalListRead> {
  const [open, closed] = await Promise.all([
    fetchAllRows<RentalListSource>(
      (from, to) =>
        rentalsOf(client, orgId)
          .eq('status', 'out')
          .order('checked_out_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      { cap: RENTAL_OPEN_ROW_CEILING },
    ),
    // rentals.status is NOT NULL and one of out, returned, cancelled
    // (0131_rentals.sql), so "not out" is exactly the closed ones.
    rentalsOf(client, orgId, { count: 'exact' })
      .neq('status', 'out')
      .order('checked_out_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, RENTAL_CLOSED_SHOWN - 1),
  ]);
  if (closed.error) {
    throw new IdBatchReadError(
      readErrorMessage(closed.error, closed.status, closed.statusText),
      closed.status ?? null,
    );
  }
  const openCapped = open.length >= RENTAL_OPEN_ROW_CEILING;
  if (openCapped) {
    console.warn(
      `rentals list reached the ${RENTAL_OPEN_ROW_CEILING}-row ceiling of rentals still out: the ones past it are not shown or counted`,
    );
  }
  const closedRows = closed.data ?? [];
  // A rental returned between the two reads can come back from both: the
  // closed row is the later state (a closed rental never reopens).
  const closedIds = new Set(closedRows.map((r) => r.id));
  const rows = [...open.filter((r) => !closedIds.has(r.id)), ...closedRows].sort(newestFirst);
  return {
    rows,
    extent: {
      closedShown: closedRows.length,
      closedTotal: typeof closed.count === 'number' ? closed.count : null,
      openCapped,
    },
  };
}

/**
 * The line under the list when it does not show every returned or cancelled
 * rental, or null when it does. Every rental still out is always listed.
 */
export function rentalHistoryNote(extent: RentalListExtent | null): string | null {
  if (!extent) return null;
  const { closedShown, closedTotal } = extent;
  if (closedTotal === null) {
    return closedShown >= RENTAL_CLOSED_SHOWN
      ? `Showing the newest ${closedShown.toLocaleString('en-US')} returned or cancelled rentals, and every rental still out. The web's Rentals page lists them all.`
      : null;
  }
  if (closedTotal <= closedShown) return null;
  return `Showing the newest ${closedShown.toLocaleString('en-US')} of ${closedTotal.toLocaleString('en-US')} returned or cancelled rentals, and every rental still out. The web's Rentals page lists them all.`;
}
