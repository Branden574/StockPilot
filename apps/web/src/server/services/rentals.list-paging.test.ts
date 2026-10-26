import { describe, expect, it } from 'vitest';

/**
 * The web Rentals list pages through every rental (B32).
 *
 * It read `.limit(500)`, newest first, and nothing said so: on the All and
 * Returned views of an organization with more than 500 rentals, the older
 * ones were simply not there. It now reads 50 at a time with an exact count,
 * in a stable order (checked out newest first, then id, so two rentals
 * checked out at the same instant never both land on one page, or neither),
 * and a page past the end (a stale link, or rentals that left the view since)
 * shows the last page instead of an empty one.
 *
 * The stub answers like PostgREST, count included: `count=exact` on a window
 * that starts past the end is a 416 (PGRST103) with no count, a window that
 * starts exactly at the end is an empty 200 with the count.
 */

import {
  callArgs,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { RENTALS_PAGE_SIZE, RentalsService } from './rentals';

const ORG = 'org-test';
const uuid = (i: number) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`;
const MINUTE = 60_000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');

/** n rentals; rental i was checked out i minutes after T0 (so the newest is
 *  the last), all returned unless `status` says otherwise. */
function rentals(n: number, status: (i: number) => string = () => 'returned') {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    organization_id: ORG,
    warehouse_id: 'wh-1',
    status: status(i),
    borrower_name: `Borrower ${i}`,
    checked_out_at: new Date(T0 + i * MINUTE).toISOString(),
    expected_return_at: new Date(T0 + (i + 60 * 24) * MINUTE).toISOString(),
    lines: [],
  }));
}

/** PostgREST over `rows`, with the count and the out-of-range answer. */
function served(rows: Array<Record<string, unknown>>, seen: MockCall[] = []) {
  const base = servedLikePostgrest(rows);
  return (call: MockCall) => {
    seen.push(call);
    const opts = (callArgs(call, 'select')?.[1] ?? {}) as { count?: string; head?: boolean };
    const filters: MockCall = { ...call, methods: [], args: [] };
    call.methods.forEach((m, i) => {
      if (m !== 'range' && m !== 'order' && m !== 'limit') {
        filters.methods.push(m);
        filters.args.push(call.args[i] ?? []);
      }
    });
    const total = (base(filters).data as unknown[]).length;
    if (opts.head) return { data: null, error: null, count: total };
    const range = callArgs(call, 'range') as [number, number] | undefined;
    if (opts.count && range && range[0] > total) {
      return {
        data: null,
        error: { code: 'PGRST103', message: 'Requested range not satisfiable' },
        count: null,
      };
    }
    return { ...base(call), count: opts.count ? total : null };
  };
}

function svcOver(rows: Array<Record<string, unknown>>, seen: MockCall[] = []) {
  const stub = makeSupabaseStub({ 'rentals.select': served(rows, seen) });
  return new RentalsService(makeServiceContext(stub.client) as never);
}

const ids = (list: Array<{ id: string }>) => list.map((r) => r.id);

describe('RentalsService.list: every rental, 50 a page', () => {
  it('is 50 a page', () => {
    expect(RENTALS_PAGE_SIZE).toBe(50);
  });

  it('500 rentals: page 10 ends with the oldest', async () => {
    const out = await svcOver(rentals(500)).list({ status: 'all', page: 10 });
    expect(out).toMatchObject({ total: 500, page: 10, pageSize: 50 });
    expect(out.rentals).toHaveLength(50);
    expect(out.rentals.at(-1)?.id).toBe(uuid(0));
  });

  // Mutation caught: the old `.limit(500)` (rental 0, the oldest, was gone).
  it('501 rentals: page 11 holds the oldest, and the total says 501', async () => {
    const out = await svcOver(rentals(501)).list({ status: 'returned', page: 11 });
    expect(out).toMatchObject({ total: 501, page: 11 });
    expect(ids(out.rentals)).toEqual([uuid(0)]);
  });

  it('newest first, then by id, a window at a time', async () => {
    const seen: MockCall[] = [];
    const out = await svcOver(rentals(120), seen).list({ status: 'all', page: 2 });
    expect(ids(out.rentals)).toEqual(Array.from({ length: 50 }, (_, i) => uuid(69 - i)));
    const read = seen.find((c) => !(callArgs(c, 'select')?.[1] as { head?: boolean })?.head)!;
    const orders = read.methods.flatMap((m, i) => (m === 'order' ? [read.args[i]] : []));
    expect(orders).toEqual([
      ['checked_out_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(callArgs(read, 'range')).toEqual([50, 99]);
  });

  it('two rentals checked out at the same instant are on exactly one page each', async () => {
    const same = rentals(51).map((r) => ({ ...r, checked_out_at: new Date(T0).toISOString() }));
    const svc = svcOver(same);
    const first = await svc.list({ status: 'all', page: 1 });
    const second = await svc.list({ status: 'all', page: 2 });
    const all = [...ids(first.rentals), ...ids(second.rentals)];
    expect(all).toHaveLength(51);
    expect(new Set(all).size).toBe(51);
  });

  it('a page past the end shows the last page (offset past the total: 416)', async () => {
    const out = await svcOver(rentals(120)).list({ status: 'all', page: 9 });
    expect(out).toMatchObject({ total: 120, page: 3 });
    expect(ids(out.rentals)).toEqual(Array.from({ length: 20 }, (_, i) => uuid(19 - i)));
  });

  it('a page starting exactly at the end shows the last page (an empty 200)', async () => {
    const out = await svcOver(rentals(100)).list({ status: 'all', page: 3 });
    expect(out).toMatchObject({ total: 100, page: 2 });
    expect(out.rentals).toHaveLength(50);
  });

  it('no rentals at all: page 1, total 0, nothing to clamp', async () => {
    const out = await svcOver([]).list({ status: 'all', page: 4 });
    expect(out).toEqual({ rentals: [], total: 0, page: 1, pageSize: 50 });
  });

  it('a page that is not a positive whole number is page 1', async () => {
    for (const page of [0, -3, Number.NaN, 2.5]) {
      const out = await svcOver(rentals(60)).list({ status: 'all', page });
      expect(out.page).toBe(page === 2.5 ? 2 : 1);
    }
  });

  it('the Overdue view counts and pages only out rentals past their return', async () => {
    const now = Date.now();
    const rows = rentals(60, (i) => (i % 2 === 0 ? 'out' : 'returned')).map((r, i) => ({
      ...r,
      // Every out rental with an even index under 40 is overdue; the rest are not due yet.
      expected_return_at: new Date(now + (i < 40 ? -1 : 1) * 60 * MINUTE).toISOString(),
    }));
    const out = await svcOver(rows).list({ status: 'overdue', page: 1 });
    expect(out.total).toBe(20);
    expect(out.rentals.every((r) => r.status === 'out')).toBe(true);
  });

  it('a failed read throws instead of an empty list', async () => {
    const stub = makeSupabaseStub({
      'rentals.select': { data: null, error: { message: 'boom' } },
    });
    const svc = new RentalsService(makeServiceContext(stub.client) as never);
    await expect(svc.list({ status: 'all' })).rejects.toMatchObject({ code: 'internal_error' });
  });
});
