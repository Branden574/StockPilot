import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Users tab is the ONLY surface in the product that can disable or
 * re-enable an account, so whatever getOrgMembers cannot return is a member
 * nobody can act on anywhere.
 *
 * Two contracts are pinned here:
 *
 *   1. STATUS — the tab cannot show a chip, or decide which of Disable /
 *      Re-enable to offer, unless the projection carries disabled_at.
 *   2. REACHABILITY — every member of an org of ANY size must be reachable.
 *      This used to be `.limit(DETAIL_PREVIEW_LIMIT)` with no search, no
 *      pagination and (uniquely among the detail tabs) no cap note, so in an
 *      org with more than 100 accepted members the 101st onwards had no
 *      three-dot menu anywhere in the product and could not be disabled at
 *      all — while the console rendered a complete-looking table. Raising the
 *      number would only move that cliff, so the fix is structural: exact
 *      count + server-side search + real pages.
 */

type Recorded = {
  select: string | null;
  selectOptions: unknown;
  or: unknown[] | null;
  range: unknown[] | null;
  order: unknown[][];
};

type QueuedResponse = {
  rows: Array<Record<string, unknown>>;
  count: number | null;
  error: { message: string; code?: string } | null;
};

const state: {
  rows: Array<Record<string, unknown>>;
  count: number | null;
  error: { message: string; code?: string } | null;
  rec: Recorded;
  /**
   * When set, each awaited query pops the NEXT entry off this queue instead
   * of the static rows/count/error above — lets a test simulate the SAME
   * query returning a 416/PGRST103 the first time and a real page the
   * second (the retry-page-1 behavior of an out-of-range page).
   */
  responses: QueuedResponse[] | null;
  /** Every range() call across every query issued in the test, in order —
   *  unlike `rec.range` (last call only), this lets a retry test assert on
   *  BOTH the original out-of-range request and the retry. */
  rangeCalls: unknown[][];
  /** Every select() call across every query issued in the test, in order —
   *  lets a test tell the count-first head query (head: true, no range())
   *  apart from the real data query (head: false, followed by range()). */
  selectCalls: Array<{ cols: string; options: unknown }>;
} = {
  rows: [],
  count: 0,
  error: null,
  rec: { select: null, selectOptions: null, or: null, range: null, order: [] },
  responses: null,
  rangeCalls: [],
  selectCalls: [],
};

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      // Thenable at every link so the service can terminate the chain wherever
      // it likes — the real builder does exactly that.
      const q: Record<string, unknown> = {};
      const settle = (resolve: (v: unknown) => void) => {
        if (state.responses && state.responses.length > 0) {
          const next = state.responses.shift()!;
          resolve({ data: next.rows, error: next.error, count: next.count });
          return;
        }
        resolve({ data: state.rows, error: state.error, count: state.count });
      };
      q.then = (resolve: (v: unknown) => void) => settle(resolve);
      q.select = vi.fn((cols: string, options?: unknown) => {
        state.rec.select = cols;
        state.rec.selectOptions = options;
        state.selectCalls.push({ cols, options });
        return q;
      });
      q.or = vi.fn((...a: unknown[]) => {
        state.rec.or = a;
        return q;
      });
      q.range = vi.fn((...a: unknown[]) => {
        state.rec.range = a;
        state.rangeCalls.push(a);
        return q;
      });
      q.order = vi.fn((...a: unknown[]) => {
        state.rec.order.push(a);
        return q;
      });
      q.eq = vi.fn(() => q);
      q.not = vi.fn(() => q);
      q.is = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      return q;
    },
  }),
}));

import { getOrgMembers, MEMBERS_PAGE_SIZE } from './orgs';

const ORG = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  state.rows = [];
  state.count = 0;
  state.error = null;
  state.rec = { select: null, selectOptions: null, or: null, range: null, order: [] };
  state.responses = null;
  state.rangeCalls = [];
  state.selectCalls = [];
});

describe('getOrgMembers — account status', () => {
  it('asks the profile embed for disabled_at', async () => {
    await getOrgMembers(ORG);
    expect(state.rec.select).toContain('disabled_at');
  });

  it('carries a disabled timestamp through to the row', async () => {
    state.rows = [
      {
        user_id: 'u-1',
        role: 'member',
        accepted_at: '2026-01-01T00:00:00Z',
        user_profiles: {
          email: 'a@example.com',
          full_name: 'Ada',
          disabled_at: '2026-07-30T12:00:00Z',
        },
      },
    ];
    state.count = 1;
    const member = (await getOrgMembers(ORG)).members[0]!;
    expect(member.disabledAt).toBe('2026-07-30T12:00:00Z');
    expect(member.email).toBe('a@example.com');
  });

  it('reports an active account as null, including when the embed arrives as an array', async () => {
    state.rows = [
      {
        user_id: 'u-2',
        role: 'admin',
        accepted_at: '2026-01-02T00:00:00Z',
        user_profiles: [{ email: 'b@example.com', full_name: null, disabled_at: null }],
      },
      { user_id: 'u-3', role: 'member', accepted_at: null, user_profiles: null },
    ];
    state.count = 2;
    const { members } = await getOrgMembers(ORG);
    expect(members[0]!.disabledAt).toBeNull();
    expect(members[1]!.disabledAt).toBeNull();
    expect(members[1]!.email).toBeNull();
  });
});

describe('getOrgMembers — reachability in a large org', () => {
  it('reports the EXACT total so a truncated page can never look complete', async () => {
    state.count = 150;
    const page = await getOrgMembers(ORG);
    expect(state.rec.selectOptions).toMatchObject({ count: 'exact' });
    expect(page.total).toBe(150);
    expect(page.pageSize).toBe(MEMBERS_PAGE_SIZE);
    expect(page.pageCount).toBe(Math.ceil(150 / MEMBERS_PAGE_SIZE));
  });

  it('pages with range(), so members past the first page are fetchable', async () => {
    state.count = 150;
    const page = await getOrgMembers(ORG, { page: 3 });
    expect(state.rec.range).toEqual([
      2 * MEMBERS_PAGE_SIZE,
      3 * MEMBERS_PAGE_SIZE - 1,
    ]);
    expect(page.page).toBe(3);
  });

  it('orders deterministically, so a row cannot hide between pages', async () => {
    await getOrgMembers(ORG, { page: 2 });
    // A tie on accepted_at with no tiebreaker lets Postgres reorder rows
    // between the two range queries, which can drop a member entirely.
    expect(state.rec.order.length).toBeGreaterThanOrEqual(2);
    expect(state.rec.order[0]![0]).toBe('accepted_at');
    expect(state.rec.order[1]![0]).toBe('user_id');
  });

  it('clamps a nonsense page rather than sending a negative range', async () => {
    await getOrgMembers(ORG, { page: 0 });
    expect(state.rec.range).toEqual([0, MEMBERS_PAGE_SIZE - 1]);
    await getOrgMembers(ORG, { page: -5 });
    expect(state.rec.range).toEqual([0, MEMBERS_PAGE_SIZE - 1]);
  });
});

describe('getOrgMembers — search', () => {
  it('filters on the embedded profile by email and name', async () => {
    const page = await getOrgMembers(ORG, { search: 'ada' });
    const [filter, options] = state.rec.or ?? [];
    expect(String(filter)).toContain('email.ilike.%ada%');
    expect(String(filter)).toContain('full_name.ilike.%ada%');
    // Without referencedTable the filter would be applied to
    // organization_members, which has neither column.
    expect(options).toMatchObject({ referencedTable: 'user_profiles' });
    expect(page.search).toBe('ada');
  });

  it('makes the embed INNER when searching, so the filter narrows the rows', async () => {
    await getOrgMembers(ORG, { search: 'ada' });
    // A non-inner embed answers an embedded filter by nulling the embed and
    // KEEPING the top-level row — every member would still be returned.
    expect(state.rec.select).toContain('!inner');
  });

  it('leaves the embed non-inner without a search, so a member with no profile row still lists', async () => {
    await getOrgMembers(ORG);
    expect(state.rec.select).not.toContain('!inner');
    expect(state.rec.or).toBeNull();
  });

  it('neutralises PostgREST metacharacters in the term', async () => {
    await getOrgMembers(ORG, { search: 'a%b,c)' });
    const filter = String((state.rec.or ?? [])[0]);
    expect(filter).not.toContain('%b,');
    expect(filter).not.toContain(')');
  });

  it('treats a blank search as no search at all', async () => {
    const page = await getOrgMembers(ORG, { search: '   ' });
    expect(state.rec.or).toBeNull();
    expect(page.search).toBeNull();
  });
});

/**
 * An out-of-range `?page=` (a stale URL, a bookmark, or a search that just
 * shrank the result set) sends `.range()` an offset PostgREST cannot serve —
 * it answers with a 416/PGRST103 instead of an empty page. Unhandled, that
 * throws out of getOrgMembers, which the Users tab server component does not
 * catch and there is no error.tsx under (platform) — so the WHOLE org-detail
 * page 500s, on the one surface that can disable an account.
 *
 * getOrgMembers clamps the requested page against a REAL count fetched
 * FIRST (a `head: true` query, no rows, no range()), so the requested page
 * is turned into an offset only after it's known to be valid. This closes
 * two holes a bare "attempt, catch PGRST103, retry page 1" approach left
 * open: a pathologically large page number never becomes a raw offset at
 * all (so it can't hit a numeric-overflow error PostgREST doesn't report as
 * PGRST103 either), and an exact-multiple total never gets requested one
 * page past its real last page (so `page > pageCount` can't be rendered).
 * The PGRST103 catch/retry-at-page-1 SURVIVES as a narrow belt-and-braces
 * fallback for the residual race between the count read and the data read.
 */
describe('getOrgMembers — out-of-range page', () => {
  it('counts FIRST (head: true, no range()) before ever issuing the data query', async () => {
    state.count = 150;
    await getOrgMembers(ORG, { page: 2 });

    expect(state.selectCalls).toHaveLength(2);
    expect(state.selectCalls[0]!.options).toMatchObject({ count: 'exact', head: true });
    expect(state.selectCalls[1]!.options).toMatchObject({ count: 'exact', head: false });
    // The head query issues no range() at all — only the data query does.
    expect(state.rangeCalls).toHaveLength(1);
  });

  it('clamps a pathologically large page to the real last page, never sending that raw number as an offset', async () => {
    state.count = 5; // pageSize 50 → exactly one real page
    const page = await getOrgMembers(ORG, { page: 999_999_999_999 });

    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(1);
    // The hostile number never became a range() offset — the ONLY range()
    // call made is page 1's.
    expect(state.rangeCalls).toEqual([[0, MEMBERS_PAGE_SIZE - 1]]);
  });

  it('treats a NaN page (an unparsed "?page=abc") as page 1 instead of propagating NaN into a range()', async () => {
    state.count = 5;
    const page = await getOrgMembers(ORG, { page: NaN });

    expect(page.page).toBe(1);
    expect(state.rangeCalls).toEqual([[0, MEMBERS_PAGE_SIZE - 1]]);
  });

  it('treats Infinity as page 1 rather than an offset that can never be reached', async () => {
    state.count = 5;
    const page = await getOrgMembers(ORG, { page: Infinity });

    expect(page.page).toBe(1);
    expect(state.rangeCalls).toEqual([[0, MEMBERS_PAGE_SIZE - 1]]);
  });

  it('never renders page > pageCount at an exact-multiple boundary (the offset === total edge)', async () => {
    // total is an exact multiple of pageSize: a page ONE PAST the real last
    // page would ask for offset === total, which PostgREST answers with
    // 200/empty rather than an error — no PGRST103 for a bare retry to
    // catch. Count-first must never let that request happen at all.
    state.count = 2 * MEMBERS_PAGE_SIZE;
    const page = await getOrgMembers(ORG, { page: 3 });

    expect(page.page).toBe(2); // clamped to the real last page, not 3
    expect(page.pageCount).toBe(2);
    expect(page.page).toBeLessThanOrEqual(page.pageCount);
    // offset === total (100) was never requested — only page 2's offset (50).
    expect(state.rangeCalls).toEqual([
      [1 * MEMBERS_PAGE_SIZE, 2 * MEMBERS_PAGE_SIZE - 1],
    ]);
  });

  it('falls back to page 1 if the data query STILL 416s despite the count-first clamp (residual race)', async () => {
    // Models a total that shrinks in the gap BETWEEN the count-first read
    // and the data read (e.g. a concurrent bulk removal mid-request): the
    // head query reports enough rows to justify page 2, but by the time
    // the data query runs at that (correctly clamped) offset, the real
    // total has dropped further and PostgREST 416s anyway.
    state.responses = [
      { rows: [], count: 2 * MEMBERS_PAGE_SIZE, error: null }, // head: total=100 → pageCount 2
      {
        rows: [],
        count: null,
        error: { message: 'An offset of 50 was requested, but there are only 5 rows.', code: 'PGRST103' },
      }, // data at clamped page 2: still out of range
      {
        rows: [
          {
            user_id: 'u-1',
            role: 'member',
            accepted_at: '2026-01-01T00:00:00Z',
            user_profiles: { email: 'a@example.com', full_name: 'Ada', disabled_at: null },
          },
        ],
        count: 5,
        error: null,
      }, // retry at page 1: succeeds
    ];

    const page = await getOrgMembers(ORG, { page: 2 });

    expect(page.page).toBe(1);
    expect(page.total).toBe(5);
    expect(page.members).toHaveLength(1);
    expect(state.rangeCalls).toEqual([
      [1 * MEMBERS_PAGE_SIZE, 2 * MEMBERS_PAGE_SIZE - 1], // the clamped-but-still-stale attempt
      [0, MEMBERS_PAGE_SIZE - 1], // the belt-and-braces retry
    ]);
  });

  it('does not swallow a real query error on the count-first read', async () => {
    state.error = { message: 'connection reset', code: '57P01' };
    await expect(getOrgMembers(ORG, { page: 2 })).rejects.toThrow('connection reset');
    // The head query itself failed — no data query, no range() call, ever.
    expect(state.rangeCalls).toHaveLength(0);
  });

  it('does not swallow a real (non-PGRST103) error from the data query either', async () => {
    state.responses = [
      { rows: [], count: 2 * MEMBERS_PAGE_SIZE, error: null }, // head succeeds
      { rows: [], count: null, error: { message: 'connection reset', code: '57P01' } }, // data fails, not PGRST103
    ];
    await expect(getOrgMembers(ORG, { page: 2 })).rejects.toThrow('connection reset');
    // Exactly one data-query attempt — a non-PGRST103 error must not
    // trigger the retry.
    expect(state.rangeCalls).toHaveLength(1);
  });
});
