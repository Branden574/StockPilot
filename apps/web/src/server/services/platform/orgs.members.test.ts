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

const state: {
  rows: Array<Record<string, unknown>>;
  count: number | null;
  error: { message: string } | null;
  rec: Recorded;
} = {
  rows: [],
  count: 0,
  error: null,
  rec: { select: null, selectOptions: null, or: null, range: null, order: [] },
};

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      // Thenable at every link so the service can terminate the chain wherever
      // it likes — the real builder does exactly that.
      const q: Record<string, unknown> = {};
      const settle = (resolve: (v: unknown) => void) =>
        resolve({ data: state.rows, error: state.error, count: state.count });
      q.then = (resolve: (v: unknown) => void) => settle(resolve);
      q.select = vi.fn((cols: string, options?: unknown) => {
        state.rec.select = cols;
        state.rec.selectOptions = options;
        return q;
      });
      q.or = vi.fn((...a: unknown[]) => {
        state.rec.or = a;
        return q;
      });
      q.range = vi.fn((...a: unknown[]) => {
        state.rec.range = a;
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
