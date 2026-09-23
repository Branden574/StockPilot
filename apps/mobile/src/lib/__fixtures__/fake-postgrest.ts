/**
 * A fake of the slice of the Supabase client the id-list readers use
 * (IdReadClient in ../id-batches.ts). Not a test file: vitest only collects
 * `*.test.ts`, and this module is imported by the tests that need it.
 *
 * Every chain records its table, select, filters and order, and each
 * `.range(from, to)` call resolves through the handler, which decides what the
 * "server" answers: rows, an `{ error }`, a thrown rejection, or a promise the
 * test holds open to observe concurrency.
 */

import type { IdReadClient, PageResult } from '../id-batches';

export type FilterOp = 'eq' | 'in' | 'is' | 'not' | 'gt';

export interface RecordedCall {
  table: string;
  select: string;
  filters: [FilterOp, string, unknown][];
  order: [string, boolean][];
  from: number;
  to: number;
}

export type FakeHandler = (
  call: RecordedCall,
) => PageResult<unknown> | Promise<PageResult<unknown>>;

export interface FakeClient extends IdReadClient {
  calls: RecordedCall[];
}

/** The `.in()` values a call sent for `column`, or undefined. */
export function inValues(call: RecordedCall, column: string): unknown[] | undefined {
  const f = call.filters.find(([op, col]) => op === 'in' && col === column);
  return f ? (f[2] as unknown[]) : undefined;
}

/** The value of the first filter `op` on `column`, or undefined. */
export function filterValue(call: RecordedCall, op: FilterOp, column: string): unknown {
  return call.filters.find(([o, col]) => o === op && col === column)?.[2];
}

export function fakePostgrest(handler: FakeHandler): FakeClient {
  const calls: RecordedCall[] = [];
  const client: FakeClient = {
    calls,
    from(table: string) {
      return {
        select(columns: string) {
          const filters: RecordedCall['filters'] = [];
          const order: RecordedCall['order'] = [];
          const chain = {
            eq(col: string, val: unknown) {
              filters.push(['eq', col, val]);
              return chain;
            },
            in(col: string, vals: readonly unknown[]) {
              filters.push(['in', col, [...vals]]);
              return chain;
            },
            is(col: string, val: null) {
              filters.push(['is', col, val]);
              return chain;
            },
            not(col: string, operator: string, val: unknown) {
              filters.push(['not', col, [operator, val]]);
              return chain;
            },
            gt(col: string, val: number) {
              filters.push(['gt', col, val]);
              return chain;
            },
            order(col: string, opts?: { ascending?: boolean }) {
              order.push([col, opts?.ascending ?? true]);
              return chain;
            },
            range(from: number, to: number) {
              const call: RecordedCall = {
                table,
                select: columns,
                filters: [...filters],
                order: [...order],
                from,
                to,
              };
              calls.push(call);
              return Promise.resolve().then(() => handler(call));
            },
          };
          return chain;
        },
      };
    },
  };
  return client;
}

/** A server that answers every read with the rows `rowsFor` returns for it,
 *  sliced to the requested range. */
export function rowsServer(rowsFor: (call: RecordedCall) => unknown[]): FakeHandler {
  return (call) => ({
    data: rowsFor(call).slice(call.from, call.to + 1),
    error: null,
    status: 200,
    statusText: 'OK',
  });
}

export function uuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
