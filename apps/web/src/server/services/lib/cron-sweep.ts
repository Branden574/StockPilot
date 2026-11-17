import 'server-only';

import { mapWithConcurrency } from '@/lib/supabase/in-filter';

/**
 * Helpers for scheduled jobs that visit every organization: an order that
 * puts the organizations a job reached longest ago first, a window that
 * rotates through all of them over consecutive runs, and a sweep that stops
 * STARTING work at a soft deadline and says how much it left.
 *
 * Why. A job that walks the organizations in the same order every run, and
 * stops at its time limit, reaches the same first ones every run and never
 * the rest. Ordering by "longest since this job last reached it" (or
 * rotating a window) makes a cut fall on different organizations each run,
 * so every one is reached within a bounded number of runs. The deadline only
 * stops new work from starting; work already started finishes inside the
 * route's maxDuration, so nothing is cut half way.
 */

/**
 * `ids` sorted so that the one with the oldest `lastAt` comes first. An id
 * with no entry (never reached, or the read that would say failed) comes
 * before every id that has one. Ties, including all the ids with no entry,
 * keep their order in `ids` (the sort is stable).
 */
export function oldestFirst(ids: readonly string[], lastAt: ReadonlyMap<string, number>): string[] {
  const keyOf = (id: string): number => {
    const v = lastAt.get(id);
    return v === undefined || !Number.isFinite(v) ? Number.NEGATIVE_INFINITY : v;
  };
  return [...ids].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

/**
 * The newest time per key in `rows` (for example the last restore point per
 * organization), as epoch milliseconds. Rows whose time does not parse are
 * left out.
 */
export function newestPerKey<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  timeOf: (row: Row) => string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const t = Date.parse(timeOf(row) ?? '');
    if (!Number.isFinite(t)) continue;
    const key = keyOf(row);
    const prev = out.get(key);
    if (prev === undefined || t > prev) out.set(key, t);
  }
  return out;
}

/**
 * A window of `size` ids that moves on by `size` each slot, wrapping around:
 * slot s starts at (s * size) mod N. Consecutive slots cover consecutive,
 * non-overlapping stretches of `ids` until they wrap, so every id is in at
 * least one window of any ceil(N / size) consecutive slots (with `ids` in a
 * stable order). With N <= size every slot is all of `ids`, in order.
 */
export function rotatingWindow(ids: readonly string[], size: number, slot: number): string[] {
  const n = ids.length;
  const width = Math.max(0, Math.floor(size));
  if (n <= width) return [...ids];
  const s = Math.floor(slot);
  const start = ((((s % n) * (width % n)) % n) + n) % n;
  const out: string[] = [];
  for (let i = 0; i < width; i += 1) out.push(ids[(start + i) % n] as string);
  return out;
}

/** What happened to one item of a deadline sweep. */
export type SweepEntry<T, R> =
  | { item: T; started: false }
  | { item: T; started: true; ok: true; value: R }
  | { item: T; started: true; ok: false; error: unknown };

/**
 * Runs `fn` over `items` in order, at most `concurrency` at once, and starts
 * no item once `Date.now()` has reached `deadlineAt`. The check is made
 * right before each start, with nothing awaited between it and the call to
 * `fn`. An item that throws is recorded and never stops the others. Items
 * not started are returned as `started: false`, in order, so the caller can
 * report how many it left for the next run.
 */
export async function sweepUntilDeadline<T, R>(
  items: readonly T[],
  opts: { concurrency: number; deadlineAt: number },
  fn: (item: T) => Promise<R>,
): Promise<{ entries: SweepEntry<T, R>[]; started: number; leftForNextRun: number }> {
  const entries = await mapWithConcurrency(
    items,
    opts.concurrency,
    async (item): Promise<SweepEntry<T, R>> => {
      if (Date.now() >= opts.deadlineAt) return { item, started: false };
      try {
        return { item, started: true, ok: true, value: await fn(item) };
      } catch (error) {
        return { item, started: true, ok: false, error };
      }
    },
  );
  const started = entries.filter((e) => e.started).length;
  return { entries, started, leftForNextRun: entries.length - started };
}
