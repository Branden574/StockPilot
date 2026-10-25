import { describe, expect, it } from 'vitest';

import {
  deriveInstantView,
  findDisplayGroupPage,
  instantStateFromPageParams,
  instantStateFromSearchParams,
  pageHoldingDisplayGroup,
  parseRevealGroupParam,
  planGroupAwarePage,
  runAwarePages,
  sortInstantRows,
  type InstantModeRow,
} from './instant-mode';

// B5 (2026-10-24 docket): after Group selected on the web, the new group's
// header can land on another page than the one the records were picked on. A
// display group is one unit that clusters at its best-ranked record (by the
// list's sort), and pages are packed unit by unit, so a group made of records
// from two pages (or one that no longer fits the end of its page) is drawn
// elsewhere. The list turns to the page that holds the header: instant mode
// works it out from the rows it holds; a server page is planned with the
// group's id (?group=), and both use one rule.

const G = '0e5f2c1a-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

function row(id: string, rank: number, over: Partial<InstantModeRow> = {}): InstantModeRow {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Item ${id}`,
    status: 'active',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 1,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    // updated_desc: a lower rank sorts higher on the list.
    updated_at: new Date(Date.UTC(2026, 9, 1) - rank * 60_000).toISOString(),
    ...over,
  };
}

/** 90 plain records (three pages of 30), plus the given extra rows. */
function view(extra: InstantModeRow[]): InstantModeRow[] {
  const rows: InstantModeRow[] = [];
  for (let i = 1; i <= 90; i++) rows.push(row(`r${String(i).padStart(3, '0')}`, i * 10));
  return [...rows, ...extra];
}

const DEFAULT = instantStateFromPageParams({});

describe('parseRevealGroupParam: only a group id, never anything else', () => {
  it('takes a uuid in either case and answers it in lower case', () => {
    expect(parseRevealGroupParam(G)).toBe(G);
    expect(parseRevealGroupParam(G.toUpperCase())).toBe(G);
  });

  it.each([[undefined], [null], [''], ['  '], ['not-a-uuid'], [`${G},${OTHER}`], [[G]], [42]])(
    'refuses %j',
    (value) => {
      expect(parseRevealGroupParam(value)).toBeNull();
    },
  );
});

describe('pageHoldingDisplayGroup: the page that draws a group header', () => {
  it('answers the 1-based page holding the formed unit', () => {
    const rows = sortInstantRows(
      view([row('g1', 455, { display_group_id: G }), row('g2', 465, { display_group_id: G })]),
      'updated_desc',
    );
    const pages = runAwarePages(rows, 30, { sizeRuns: true });
    expect(pageHoldingDisplayGroup(pages, G)).toBe(2);
    expect(pages[1]!.map((r) => r.id)).toEqual(expect.arrayContaining(['g1', 'g2']));
  });

  it('answers null when fewer than two of its records are in the set (no header is drawn)', () => {
    const rows = sortInstantRows(view([row('g1', 455, { display_group_id: G })]), 'updated_desc');
    expect(pageHoldingDisplayGroup(runAwarePages(rows, 30), G)).toBeNull();
  });

  it('answers null for a group no record carries', () => {
    const rows = sortInstantRows(
      view([row('g1', 5, { display_group_id: G }), row('g2', 6, { display_group_id: G })]),
      'updated_desc',
    );
    expect(pageHoldingDisplayGroup(runAwarePages(rows, 30), OTHER)).toBeNull();
  });
});

describe('the reported gap: the new header is drawn on another page', () => {
  // One record high on page 1, one deep on page 3: the group clusters at the
  // best-ranked record, so its header is on page 1, whichever page the person
  // picked the second record on.
  const spread = view([
    row('g-high', 15, { display_group_id: G }),
    row('g-deep', 795, { display_group_id: G }),
  ]);

  // Two records at the end of page 2 and the start of page 3: after grouping
  // they no longer fit what is left of page 2, so the unit opens page 3.
  const straddle = view([
    row('g-a', 595, { display_group_id: G }),
    row('g-b', 605, { display_group_id: G }),
  ]);

  it('instant mode: findDisplayGroupPage names the page with the header', () => {
    expect(findDisplayGroupPage(spread, DEFAULT, 'items', 30, G)).toBe(1);
    expect(findDisplayGroupPage(straddle, DEFAULT, 'items', 30, G)).toBe(3);
    // Books page the same way (no size runs).
    expect(findDisplayGroupPage(straddle, DEFAULT, 'books', 30, G)).toBe(3);
  });

  it("instant mode honours the view's filters: a group that does not form in it has no page", () => {
    const filtered = view([
      row('g-a', 595, { display_group_id: G, category_id: 'cat-1' }),
      row('g-b', 605, { display_group_id: G, category_id: 'cat-2' }),
    ]);
    expect(
      findDisplayGroupPage(filtered, { ...DEFAULT, cat: ['cat-1'] }, 'items', 30, G),
    ).toBeNull();
  });

  it('deriveInstantView turns to the group page when the state names the group', () => {
    const v = deriveInstantView(straddle, { ...DEFAULT, page: 1, group: G }, 'items', 30);
    expect(v.page).toBe(3);
    expect(v.pageItems.map((r) => r.id)).toEqual(expect.arrayContaining(['g-a', 'g-b']));
  });

  it('deriveInstantView keeps the requested page when the named group does not form here', () => {
    expect(
      deriveInstantView(straddle, { ...DEFAULT, page: 2, group: OTHER }, 'items', 30).page,
    ).toBe(2);
  });

  it('a server page planned with the group id is the page that draws the header', () => {
    expect(planGroupAwarePage(spread, 'updated_desc', 3, 30, 'items', G).page).toBe(1);
    const plan = planGroupAwarePage(straddle, 'updated_desc', 1, 30, 'items', G);
    expect(plan.page).toBe(3);
    expect(plan.pageIds).toEqual(expect.arrayContaining(['g-a', 'g-b']));
    // Without a group, or with one that does not form, the requested page.
    expect(planGroupAwarePage(straddle, 'updated_desc', 2, 30, 'items').page).toBe(2);
    expect(planGroupAwarePage(straddle, 'updated_desc', 2, 30, 'items', OTHER).page).toBe(2);
  });

  it('instant mode and the planned server page agree on the page, for every sort', () => {
    for (const sort of ['updated_desc', 'updated_asc', 'name_asc', 'name_desc'] as const) {
      const state = { ...DEFAULT, sort };
      expect(planGroupAwarePage(straddle, sort, 1, 30, 'items', G).page).toBe(
        findDisplayGroupPage(straddle, state, 'items', 30, G),
      );
    }
  });
});

describe('the ?group= parameter reaches the state on the server and in the browser', () => {
  it('reads it from the page params and from useSearchParams alike', () => {
    expect(instantStateFromPageParams({ group: G }).group).toBe(G);
    expect(instantStateFromPageParams({ group: 'garbage' }).group).toBeNull();
    expect(instantStateFromPageParams({}).group).toBeNull();
    const sp = new URLSearchParams(`group=${G.toUpperCase()}&page=2`);
    expect(instantStateFromSearchParams(sp).group).toBe(G);
    expect(instantStateFromSearchParams(new URLSearchParams('page=2')).group).toBeNull();
  });
});
