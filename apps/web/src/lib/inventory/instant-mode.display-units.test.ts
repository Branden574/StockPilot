import { describe, expect, it } from 'vitest';

import { makeDisplayUnitKeyer } from '@stockpilot/core';
import { DISPLAY_UNITS_PARITY_FIXTURE } from '@stockpilot/core/testing/display-units';

import {
  deriveInstantView,
  instantStateFromPageParams,
  planInstantFirstPage,
  runAwarePages,
  type InstantModeRow,
} from './instant-mode';

/**
 * Group selected (migration 0400): explicit display groups enter the web's
 * pagination through core's one display rule (makeDisplayUnitKeyer). These pin
 * that runAwarePages, the planned page 1 and deriveInstantView agree with it,
 * on the shared parity fixture the core keyer and the phone run too.
 */

function row(
  id: string,
  sku: string,
  name: string,
  over: Partial<InstantModeRow> = {},
): InstantModeRow {
  return {
    id,
    sku,
    name,
    status: 'active',
    quantity_on_hand: 1,
    reorder_point: 0,
    unit_cost: 0,
    category_id: null,
    primary_location_id: null,
    charter_id: null,
    updated_at: '2026-01-01T00:00:00Z',
    group_id: null,
    display_group_id: null,
    ...over,
  };
}

/** Units as runAwarePages packs them: a page size of 1 puts each unit alone. */
function pagedUnits<T extends { id: string }>(pages: T[][]): string[][] {
  return pages.map((p) => p.map((r) => r.id));
}

describe('runAwarePages with explicit display groups', () => {
  it('makes exactly the units the shared fixture lists (core, web and phone agree)', () => {
    for (const c of DISPLAY_UNITS_PARITY_FIXTURE) {
      const pages = runAwarePages(c.rows, 1, { sizeRuns: c.sizeRuns });
      expect({ name: c.name, units: pagedUnits(pages) }).toEqual({ name: c.name, units: c.units });
    }
  });

  it('never cuts an explicit group across pages, even straddling row 30', () => {
    const rows = [
      ...Array.from({ length: 29 }, (_, i) => row(`f${i}`, `F${i}`, `Filler ${i}`)),
      row('g1', 'POLO-A', 'Polo XXXL', { display_group_id: 'gPolo' }),
      row('z', 'Z', 'Between'),
      row('g2', 'POLO-B', 'Polo XXXL', { display_group_id: 'gPolo' }),
    ];
    const pages = runAwarePages(rows, 30);
    const pageOf = (id: string) => pages.findIndex((p) => p.some((r) => r.id === id));
    expect(pageOf('g1')).toBe(pageOf('g2'));
    // 29 fillers fill page 1; the group (2) does not fit, so it starts page 2.
    expect(pageOf('g1')).toBe(1);
  });

  it('an explicit group beats a shared SKU; the rest of that SKU stays a family', () => {
    const rows = [
      row('a', 'X', 'Pad', { display_group_id: 'g' }),
      row('b', 'X', 'Pad'),
      row('c', 'X', 'Pad'),
      row('d', 'Y', 'Desk', { display_group_id: 'g' }),
    ];
    expect(pagedUnits(runAwarePages(rows, 1))).toEqual([
      ['a', 'd'],
      ['b', 'c'],
    ]);
  });

  it('keys a SKU raw: " X" and "X" are two SKUs, as the table renders them', () => {
    const rows = [row('a', 'X', 'One'), row('b', ' X', 'Two'), row('c', 'X', 'Three')];
    expect(pagedUnits(runAwarePages(rows, 1, { sizeRuns: false }))).toEqual([['a', 'c'], ['b']]);
  });

  it('is the core keyer itself (no second rule)', () => {
    const rows = [
      row('a', 'X', 'Tee - S', { display_group_id: 'g' }),
      row('b', 'Y', 'Tee - M', { display_group_id: 'g' }),
      row('c', 'Z', 'Tee - L'),
      row('d', 'W', 'Tee - XL'),
    ];
    const key = makeDisplayUnitKeyer(rows, { sizeRuns: true });
    expect(rows.map(key)).toEqual(['grp:g', 'grp:g', 'run:tee', 'run:tee']);
    expect(pagedUnits(runAwarePages(rows, 1))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('the planned page 1 with explicit groups', () => {
  it('equals the derived page 1, and counts each header unit over the whole view (no false "partial")', () => {
    const rows = [
      row('a', 'X', 'Pad', { display_group_id: 'g', updated_at: '2026-01-05T00:00:00Z' }),
      row('b', 'X', 'Pad', { updated_at: '2026-01-04T00:00:00Z' }),
      row('c', 'X', 'Pad', { updated_at: '2026-01-03T00:00:00Z' }),
      row('d', 'Y', 'Desk', { display_group_id: 'g', updated_at: '2026-01-02T00:00:00Z' }),
    ];
    const { view, firstPage } = planInstantFirstPage(rows, () => 1, 30);
    const derived = deriveInstantView(rows, instantStateFromPageParams({}), 'items', 30);
    expect(view.pageItems.map((r) => r.id)).toEqual(derived.pageItems.map((r) => r.id));
    // The group's two records and the SKU's two UNCLAIMED records, never the
    // SKU's three records (a's claim moved it out of the SKU's header).
    expect(Object.fromEntries(firstPage.unitItemRowCounts ?? [])).toEqual({
      'grp:g': 2,
      'sku:X': 2,
    });
    // The raw per-SKU count (Ungroup's input) still counts every record.
    expect(Object.fromEntries(firstPage.skuItemRowCounts)).toEqual({ X: 3, Y: 1 });
  });
});
