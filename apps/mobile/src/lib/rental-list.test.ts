import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdBatchReadError, type IdReadClient } from './id-batches';
import {
  RENTAL_CLOSED_SHOWN,
  RENTAL_OPEN_ROW_CEILING,
  readRentalList,
  rentalHistoryNote,
  type RentalListExtent,
} from './rental-list';
import { RENTAL_CONNECTION_FAILURE, rentalReadFailureMessage } from './rental-view';

/**
 * The phone's Rentals list (B32). It read the 100 newest rentals of every
 * status: past 100, an older rental still out was missing from the list and
 * from the eyebrow's OUT and OVERDUE counts. It now reads every rental still
 * out, and the newest 100 returned or cancelled ones with their count, and
 * says how many of those it does not show.
 */

const ORG = 'org-1';

interface Call {
  table: string;
  columns: string;
  count: string | undefined;
  filters: [op: 'eq' | 'neq', column: string, value: unknown][];
  order: [column: string, ascending: boolean][];
  from: number;
  to: number;
}

type Rental = { id: string; status: string; checked_out_at: string; organization_id: string };

/** rentals as PostgREST answers them: the call's own eq/neq filters and
 *  order keys, its range, never more than 1000 rows (max_rows), and the
 *  exact count only when it was asked for. So dropping a filter, an order
 *  key or the count fails a test. */
function server(
  rows: Rental[],
  fail?: (call: Call) => { message: string; status: number } | null,
): IdReadClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      return {
        select(columns: string, opts?: { count?: string }) {
          const call: Call = {
            table,
            columns,
            count: opts?.count,
            filters: [],
            order: [],
            from: -1,
            to: -1,
          };
          const chain = {
            eq(column: string, value: unknown) {
              call.filters.push(['eq', column, value]);
              return chain;
            },
            neq(column: string, value: unknown) {
              call.filters.push(['neq', column, value]);
              return chain;
            },
            order(column: string, o?: { ascending?: boolean }) {
              call.order.push([column, o?.ascending ?? true]);
              return chain;
            },
            range(from: number, to: number) {
              call.from = from;
              call.to = to;
              calls.push(call);
              const failure = fail?.(call);
              if (failure) {
                return Promise.resolve({
                  data: null,
                  error: { message: failure.message },
                  status: failure.status,
                  count: null,
                });
              }
              const matching = rows.filter((r) =>
                call.filters.every(([op, col, val]) => {
                  const v = (r as Record<string, unknown>)[col];
                  return op === 'eq' ? v === val : v !== val;
                }),
              );
              const sorted = [...matching].sort((a, b) => {
                for (const [col, asc] of call.order) {
                  const x = (a as Record<string, unknown>)[col] as string;
                  const y = (b as Record<string, unknown>)[col] as string;
                  if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
                }
                return 0;
              });
              return Promise.resolve({
                data: sorted.slice(from, Math.min(to, from + 999) + 1),
                error: null,
                status: 200,
                count: call.count === 'exact' ? matching.length : null,
              });
            },
          };
          return chain;
        },
      };
    },
  };
}

/** Rental `i`, checked out `i` minutes after a fixed start: a higher `i` is newer. */
function rental(i: number, status: string, over: Partial<Rental> = {}): Rental {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    status,
    checked_out_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    organization_id: ORG,
    ...over,
  };
}

function closed(count: number, from = 0): Rental[] {
  return Array.from({ length: count }, (_, k) =>
    rental(from + k, k % 3 === 0 ? 'cancelled' : 'returned'),
  );
}

function open(count: number, from = 0): Rental[] {
  return Array.from({ length: count }, (_, k) => rental(from + k, 'out'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readRentalList: which checkouts the phone list reads', () => {
  it('100 closed rentals: all of them, and nothing left to say', async () => {
    const { rows, extent } = await readRentalList(server(closed(100)), ORG);
    expect(rows).toHaveLength(100);
    expect(extent).toEqual({ closedShown: 100, closedTotal: 100, openCapped: false });
    expect(rentalHistoryNote(extent)).toBeNull();
  });

  it('101 closed rentals: the newest 100, and the count of all 101', async () => {
    const { rows, extent } = await readRentalList(server(closed(101)), ORG);
    expect(rows).toHaveLength(100);
    // The oldest (rental 0) is the one left out.
    expect(rows.map((r) => r.id)).not.toContain(rental(0, 'returned').id);
    expect(extent).toEqual({ closedShown: 100, closedTotal: 101, openCapped: false });
    expect(rentalHistoryNote(extent)).toBe(
      "Showing the newest 100 of 101 returned or cancelled rentals, and every rental still out. The web's Rentals page lists them all.",
    );
  });

  // The bug: `.limit(100)` across every status. A rental checked out before
  // the newest 100 and still out was not on the list, nor in "N OUT".
  it('a rental still out, older than the newest 100 closed ones, is on the list', async () => {
    const old = rental(1, 'out');
    const { rows, extent } = await readRentalList(server([old, ...closed(150, 10)]), ORG);
    expect(rows).toHaveLength(101);
    expect(rows.filter((r) => r.status === 'out').map((r) => r.id)).toEqual([old.id]);
    // Newest first, as the list always was: the old open rental is last.
    expect(rows.at(-1)?.id).toBe(old.id);
    expect(extent.closedTotal).toBe(150);
  });

  it('every rental still out, past 1000 (a second page), interleaved newest first with the closed ones', async () => {
    const all = [...open(1001, 0), ...closed(5, 2000)];
    const client = server(all);
    const { rows } = await readRentalList(client, ORG);
    expect(rows.filter((r) => r.status === 'out')).toHaveLength(1001);
    expect(rows).toHaveLength(1006);
    const times = rows.map((r) => Date.parse(r.checked_out_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const openWindows = client.calls
      .filter((c) =>
        c.filters.some(([op, col, v]) => op === 'eq' && col === 'status' && v === 'out'),
      )
      .map((c) => [c.from, c.to]);
    expect(openWindows).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('exactly 1000 still out: one more page is asked for and comes back empty', async () => {
    const client = server(open(1000));
    const { rows } = await readRentalList(client, ORG);
    expect(rows).toHaveLength(1000);
    expect(
      client.calls
        .filter((c) =>
          c.filters.some(([op]) => op === 'eq' && c.filters.length === 2 && c.count === undefined),
        )
        .map((c) => c.from),
    ).toEqual([0, 1000]);
  });

  it("asks only for this organization's rentals: open ones by status, closed ones by not out, counted", async () => {
    const client = server([
      ...open(2),
      ...closed(2, 10),
      rental(99, 'out', { organization_id: 'org-2' }),
    ]);
    const { rows } = await readRentalList(client, ORG);
    expect(rows).toHaveLength(4);
    for (const call of client.calls) {
      expect(call.table).toBe('rentals');
      expect(call.filters).toContainEqual(['eq', 'organization_id', ORG]);
      expect(call.order).toEqual([
        ['checked_out_at', false],
        ['id', false],
      ]);
      // The card, the reminder mark and the warehouse name.
      expect(call.columns).toContain('borrower_user_id, overdue_reminder_sent_at');
      expect(call.columns).toContain('warehouse:warehouses!warehouse_id (name)');
    }
    const openCall = client.calls.find((c) => c.filters.some(([, col]) => col === 'status'));
    const closedCall = client.calls.find((c) => c.filters.some(([op]) => op === 'neq'));
    expect(openCall?.filters).toEqual([
      ['eq', 'organization_id', ORG],
      ['eq', 'status', 'out'],
    ]);
    expect(openCall?.count).toBeUndefined();
    expect(closedCall?.filters).toEqual([
      ['eq', 'organization_id', ORG],
      ['neq', 'status', 'out'],
    ]);
    expect(closedCall?.count).toBe('exact');
    expect([closedCall?.from, closedCall?.to]).toEqual([0, RENTAL_CLOSED_SHOWN - 1]);
  });

  it('a rental returned between the two reads is listed once, as returned', async () => {
    const r = rental(5, 'out');
    let reads = 0;
    const client = server([r]);
    const from = client.from.bind(client);
    // The closed read sees it returned; the open read still saw it out.
    client.from = (table: string) => {
      reads += 1;
      if (reads === 2) {
        return (server([{ ...r, status: 'returned' }]) as IdReadClient).from(table);
      }
      return from(table);
    };
    const { rows } = await readRentalList(client, ORG);
    expect(rows).toEqual([{ ...r, status: 'returned' }]);
  });

  it('at the ceiling of rentals still out: says the counts may be short, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { extent, rows } = await readRentalList(server(open(RENTAL_OPEN_ROW_CEILING + 1)), ORG);
    expect(rows).toHaveLength(RENTAL_OPEN_ROW_CEILING);
    expect(extent.openCapped).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('10000-row ceiling'));
  });

  it('a failed page of rentals still out fails the read (never part of the list as the whole)', async () => {
    const client = server(open(1500), (c) =>
      c.from === 1000 ? { message: 'upstream timeout', status: 504 } : null,
    );
    const err = await readRentalList(client, ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdBatchReadError);
    expect((err as IdBatchReadError).status).toBe(504);
  });

  it('a failed closed read fails the read; with no answer at all it is said as a connection problem', async () => {
    const client = server(open(3), (c) =>
      c.filters.some(([op]) => op === 'neq')
        ? { message: 'TypeError: Network request failed', status: 0 }
        : null,
    );
    const err = await readRentalList(client, ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdBatchReadError);
    expect(rentalReadFailureMessage(err)).toBe(RENTAL_CONNECTION_FAILURE);
  });
});

describe('rentalHistoryNote', () => {
  const extent = (over: Partial<RentalListExtent>): RentalListExtent => ({
    closedShown: 100,
    closedTotal: 100,
    openCapped: false,
    ...over,
  });

  it('nothing to say when every closed rental is shown, or no list was read', () => {
    expect(rentalHistoryNote(null)).toBeNull();
    expect(rentalHistoryNote(extent({ closedShown: 3, closedTotal: 3 }))).toBeNull();
    expect(rentalHistoryNote(extent({ closedShown: 0, closedTotal: 0 }))).toBeNull();
  });

  it('a large count is grouped', () => {
    expect(rentalHistoryNote(extent({ closedTotal: 12_345 }))).toBe(
      "Showing the newest 100 of 12,345 returned or cancelled rentals, and every rental still out. The web's Rentals page lists them all.",
    );
  });

  it('with no count in the answer: a full page says it is the newest 100, with no total made up', () => {
    expect(rentalHistoryNote(extent({ closedTotal: null }))).toBe(
      "Showing the newest 100 returned or cancelled rentals, and every rental still out. The web's Rentals page lists them all.",
    );
    expect(rentalHistoryNote(extent({ closedShown: 40, closedTotal: null }))).toBeNull();
  });
});
