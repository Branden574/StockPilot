import { describe, expect, it } from 'vitest';

import { planGroupAwarePage, type InstantModeRow } from './instant-mode';

// Phase 2 of the grouping brief (owner 2026-10-11, go to start 2026-10-12):
// staff and viewers read the Items and Books lists one server page at a time,
// and those pages used to be fixed 30-row slices, so a size run (or a SKU
// family, or a display group) whose members sorted far apart was split across
// pages: the reported case was the XS of a T-shirt alone on page 2 while its
// seven other sizes showed as the run on page 1, and a staff member ordered
// every size but XS. The server now plans each page with the same group-aware
// rule managers' instant mode uses (sortInstantRows + runAwarePages), over the
// whole filtered view, and reads full rows for that page only.

const SIZES_ON_PAGE_1 = ['L', 'M', 'S', 'XL', 'XXL', 'XXXL', 'XXXXL'];

function row(id: string, over: Partial<InstantModeRow> & { rank: number }): InstantModeRow {
  const { rank, ...rest } = over;
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
    ...rest,
  };
}

/** 60 plain records plus the T-shirt's eight sizes at the given ranks. */
function view(sizeRanks: Record<string, number>, idOf = (size: string) => `tee-${size}`) {
  const rows: InstantModeRow[] = [];
  for (let i = 1; i <= 60; i++)
    rows.push(row(`r${String(i).padStart(3, '0')}`, { rank: i * 2 + 1 }));
  for (const [size, rank] of Object.entries(sizeRanks)) {
    rows.push(row(idOf(size), { rank, name: `Limits Tee - ${size}`, sku: `TEE-${size}` }));
  }
  return rows;
}

describe('planGroupAwarePage: a server page that keeps every size run, SKU family and display group whole', () => {
  it('the reported case: seven sizes high on the list and XS far below -> page 1 holds the whole run, XS included', () => {
    const ranks: Record<string, number> = {};
    SIZES_ON_PAGE_1.forEach((s, i) => (ranks[s] = 12 + i * 2)); // rows 6-12 or so
    ranks.XS = 106; // about row 53, on page 2 of fixed 30-row slices
    const rows = view(ranks);
    const plan = planGroupAwarePage(rows, 'updated_desc', 1, 30, 'items');
    for (const s of [...SIZES_ON_PAGE_1, 'XS']) expect(plan.pageIds).toContain(`tee-${s}`);
    // No page after it shows XS again.
    for (let p = 2; p <= plan.pageCount; p++) {
      expect(planGroupAwarePage(rows, 'updated_desc', p, 30, 'items').pageIds).not.toContain(
        'tee-XS',
      );
    }
  });

  it('eight sizes with one updated time straddling row 30 stay whole on one page, whatever the id order', () => {
    const ranks: Record<string, number> = {};
    for (const s of [...SIZES_ON_PAGE_1, 'XS']) ranks[s] = 58; // all share one time, around row 29
    for (const idOf of [(s: string) => `tee-${s}`, (s: string) => `zz-${s === 'XS' ? '0' : s}`]) {
      const rows = view(ranks, idOf);
      const pageOf = new Map<string, number>();
      for (
        let p = 1;
        p <= planGroupAwarePage(rows, 'updated_desc', 1, 30, 'items').pageCount;
        p++
      ) {
        for (const id of planGroupAwarePage(rows, 'updated_desc', p, 30, 'items').pageIds)
          pageOf.set(id, p);
      }
      const pages = new Set([...SIZES_ON_PAGE_1, 'XS'].map((s) => pageOf.get(idOf(s))));
      expect(pages.size).toBe(1);
    }
  });

  it('every record is on exactly one page: none lost, none repeated', () => {
    const ranks: Record<string, number> = {};
    SIZES_ON_PAGE_1.forEach((s, i) => (ranks[s] = 12 + i * 2));
    ranks.XS = 106;
    const rows = view(ranks);
    const first = planGroupAwarePage(rows, 'updated_desc', 1, 30, 'items');
    const seen: string[] = [];
    for (let p = 1; p <= first.pageCount; p++) {
      const plan = planGroupAwarePage(rows, 'updated_desc', p, 30, 'items');
      expect(plan.pageStartIndex).toBe(seen.length);
      expect(plan.pageItemCount).toBe(plan.pageIds.length);
      seen.push(...plan.pageIds);
    }
    expect(seen.length).toBe(rows.length);
    expect(new Set(seen).size).toBe(rows.length);
  });

  it('keeps a display group and a SKU family whole, and Books builds no size runs', () => {
    const rows: InstantModeRow[] = [];
    for (let i = 1; i <= 40; i++)
      rows.push(row(`r${String(i).padStart(3, '0')}`, { rank: i * 2 + 1 }));
    rows.push(
      row('g-1', { rank: 4, display_group_id: 'grp-1' }),
      row('g-2', { rank: 90, display_group_id: 'grp-1' }),
    );
    rows.push(row('k-1', { rank: 6, sku: 'PAIR' }), row('k-2', { rank: 88, sku: 'PAIR' }));
    rows.push(row('t-S', { rank: 8, name: 'Tee - S' }), row('t-M', { rank: 86, name: 'Tee - M' }));
    const items = planGroupAwarePage(rows, 'updated_desc', 1, 30, 'items').pageIds;
    expect(items).toEqual(expect.arrayContaining(['g-1', 'g-2', 'k-1', 'k-2', 't-S', 't-M']));
    const books = planGroupAwarePage(rows, 'updated_desc', 1, 30, 'books').pageIds;
    expect(books).toEqual(expect.arrayContaining(['g-1', 'g-2', 'k-1', 'k-2', 't-S']));
    // Books: the name rule does not pull the second size up.
    expect(books).not.toContain('t-M');
  });

  it('gives the pager and the headers what the whole view says: pages, the start, and the counts for the units on the page', () => {
    const rows: InstantModeRow[] = [];
    for (let i = 1; i <= 45; i++)
      rows.push(row(`r${String(i).padStart(3, '0')}`, { rank: i * 2 + 1 }));
    rows.push(
      row('k-1', { rank: 4, sku: 'PAIR' }),
      row('k-2', { rank: 80, sku: 'PAIR' }),
      row('k-3', { rank: 84, sku: 'PAIR' }),
    );
    rows.push(
      row('g-1', { rank: 6, display_group_id: 'grp-1' }),
      row('g-2', { rank: 82, display_group_id: 'grp-1' }),
    );
    const plan = planGroupAwarePage(rows, 'updated_desc', 1, 30, 'items');
    expect(plan.page).toBe(1);
    expect(plan.pageStartIndex).toBe(0);
    expect(plan.pageCount).toBe(2);
    expect(new Map(plan.skuItemRowCounts).get('PAIR')).toBe(3);
    expect(new Map(plan.unitItemRowCounts).get('grp:grp-1')).toBe(2);
    expect(new Map(plan.unitItemRowCounts).get('sku:PAIR')).toBe(3);
    expect(plan.distinctSkus).toBe(rows.length - 2); // PAIR counted once
  });

  it('a page past the end is the last page; an empty view is one empty page', () => {
    const rows = view({ S: 5, M: 7 });
    const last = planGroupAwarePage(rows, 'updated_desc', 999, 30, 'items');
    expect(last.page).toBe(last.pageCount);
    expect(last.pageIds.length).toBeGreaterThan(0);
    const empty = planGroupAwarePage([], 'updated_desc', 3, 30, 'items');
    expect(empty).toMatchObject({
      page: 1,
      pageCount: 1,
      pageIds: [],
      pageStartIndex: 0,
      pageItemCount: 0,
    });
  });

  it('sorts as instant mode does, so a staff member and a manager see one order', () => {
    const rows = view({ S: 5, M: 7 });
    const first = planGroupAwarePage(rows, 'name_asc', 1, 30, 'items');
    expect(first.pageIds[0]).toBe('r001'); // "Item r001" sorts before "Limits Tee - ..."
    // Both sizes land on one page, whichever it is.
    const pageOf = (id: string) => {
      for (let p = 1; p <= first.pageCount; p++) {
        if (planGroupAwarePage(rows, 'name_asc', p, 30, 'items').pageIds.includes(id)) return p;
      }
      return 0;
    };
    expect(pageOf('tee-S')).toBeGreaterThan(0);
    expect(pageOf('tee-S')).toBe(pageOf('tee-M'));
  });
});
