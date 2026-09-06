import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Org Directory's per-org member/item numbers.
 *
 * These used to come from ONE grouped `in('organization_id', ids)` select per
 * table, tallied client-side, under a comment claiming the read was "bounded
 * by the ≤500 org cap". What that select returns is members/items across ALL
 * listed orgs, so once their COMBINED row count passed PostgREST's
 * `max_rows = 1000` (supabase/config.toml) the response was silently truncated
 * — no error, no hint on the page — and every org's count on that page became
 * an arbitrary undercount decided by planner order.
 *
 * The mock below deliberately emulates that clamp: any non-head select is
 * truncated to MAX_ROWS, exactly as PostgREST does. A tally-the-rows
 * implementation therefore CANNOT pass these tests, whatever it selects.
 */

const MAX_ROWS = 1000; // supabase/config.toml [api] max_rows

type Fixture = { members: number; items: number };

const state: {
  orgs: Array<{ id: string; name: string; slug: string }>;
  counts: Map<string, Fixture>;
  /** Every query issued, in order: table + whether it was a head count. */
  calls: Array<{ table: string; head: boolean; orgId: string | null }>;
  /** Peak number of simultaneously in-flight queries. */
  peakInFlight: number;
  /** Tables whose count query should come back as an error. */
  failCounts: Set<string>;
} = { orgs: [], counts: new Map(), calls: [], peakInFlight: 0, failCounts: new Set() };

let inFlight = 0;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let head = false;
      let orgId: string | null = null;
      let inIds: string[] | null = null;

      const rowsFor = (): Array<Record<string, unknown>> => {
        if (table === 'organizations') return state.orgs;
        const ids = inIds ?? (orgId ? [orgId] : []);
        const out: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          const n = state.counts.get(id);
          const many = table === 'inventory_items' ? (n?.items ?? 0) : (n?.members ?? 0);
          for (let i = 0; i < many; i++) out.push({ organization_id: id, id: `${id}-${i}` });
        }
        return out;
      };

      const settle = (resolve: (v: unknown) => void) => {
        state.calls.push({ table, head, orgId });
        inFlight += 1;
        state.peakInFlight = Math.max(state.peakInFlight, inFlight);
        queueMicrotask(() => {
          inFlight -= 1;
          if (head && state.failCounts.has(table)) {
            resolve({ data: null, count: null, error: { message: 'boom' } });
            return;
          }
          const rows = rowsFor();
          resolve(
            head
              ? // A head count comes back in Content-Range and is EXACT — it is
                // not subject to max_rows, which is precisely why counting in
                // the database beats tallying rows in JS here.
                { data: null, count: rows.length, error: null }
              : // …whereas any row response is silently clamped to max_rows,
                // exactly as PostgREST does. This is the clamp that ate the old
                // grouped-select tally.
                { data: rows.slice(0, MAX_ROWS), count: null, error: null },
          );
        });
      };

      q.then = (resolve: (v: unknown) => void) => settle(resolve);
      q.select = vi.fn((_cols: string, options?: { head?: boolean }) => {
        head = Boolean(options?.head);
        return q;
      });
      q.eq = vi.fn((col: string, value: string) => {
        if (col === 'organization_id') orgId = value;
        return q;
      });
      q.in = vi.fn((col: string, values: string[]) => {
        if (col === 'organization_id') inIds = values;
        return q;
      });
      q.not = vi.fn(() => q);
      q.is = vi.fn(() => q);
      q.or = vi.fn(() => q);
      q.order = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      q.range = vi.fn(() => q);
      return q;
    },
  }),
}));

import { listOrgsForPlatform } from './orgs';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

beforeEach(() => {
  state.orgs = [];
  state.counts = new Map();
  state.calls = [];
  state.peakInFlight = 0;
  state.failCounts = new Set();
  inFlight = 0;
});

describe('listOrgsForPlatform — per-org counts', () => {
  it('reports EXACT counts when the listed orgs together hold more than PostgREST returns', async () => {
    state.orgs = [
      { id: A, name: 'Alpha', slug: 'alpha' },
      { id: B, name: 'Beta', slug: 'beta' },
    ];
    // 1,503 items and 1,202 members across the page — both well past the
    // 1000-row clamp, which is what silently ate the old tally.
    state.counts.set(A, { members: 1200, items: 1500 });
    state.counts.set(B, { members: 2, items: 3 });

    const { orgs } = await listOrgsForPlatform();

    const byId = new Map(orgs.map((o) => [o.id, o]));
    expect(byId.get(A)!.itemCount).toBe(1500);
    expect(byId.get(A)!.memberCount).toBe(1200);
    // The org that lost ALL its rows to the clamp under the old tally.
    expect(byId.get(B)!.itemCount).toBe(3);
    expect(byId.get(B)!.memberCount).toBe(2);
  });

  it('asks the database to count, rather than pulling rows over the wire to count them', async () => {
    state.orgs = [{ id: A, name: 'Alpha', slug: 'alpha' }];
    state.counts.set(A, { members: 4, items: 7 });

    await listOrgsForPlatform();

    const countTables = state.calls.filter((c) => c.table !== 'organizations');
    expect(countTables.length).toBeGreaterThan(0);
    // Not one row of members/items may be fetched just to be tallied.
    expect(countTables.every((c) => c.head)).toBe(true);
  });

  it('issues no count queries at all when the directory is empty', async () => {
    const { orgs } = await listOrgsForPlatform();
    expect(orgs).toEqual([]);
    expect(state.calls.filter((c) => c.table !== 'organizations')).toEqual([]);
  });

  it('counts a large directory without an unbounded request stampede', async () => {
    state.orgs = Array.from({ length: 60 }, (_, i) => ({
      id: `org-${i}`,
      name: `Org ${i}`,
      slug: `org-${i}`,
    }));
    for (const o of state.orgs) state.counts.set(o.id, { members: 1, items: 2 });

    const { orgs } = await listOrgsForPlatform();

    expect(orgs).toHaveLength(60);
    expect(orgs.every((o) => o.itemCount === 2 && o.memberCount === 1)).toBe(true);
    // Two numbers per org must never become 120 simultaneous requests from one
    // page render — the counts run through a bounded pool.
    expect(state.peakInFlight).toBeLessThanOrEqual(32);
  });

  it('degrades ONE number instead of taking the whole directory down when a count errors', async () => {
    state.orgs = [{ id: A, name: 'Alpha', slug: 'alpha' }];
    state.counts.set(A, { members: 4, items: 7 });
    state.failCounts.add('inventory_items');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // There is no error.tsx under (platform); a throw here would blank the
    // console rather than show a stale number.
    const { orgs } = await listOrgsForPlatform();
    expect(orgs[0]!.memberCount).toBe(4);
    expect(orgs[0]!.itemCount).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
