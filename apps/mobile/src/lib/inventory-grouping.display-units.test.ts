import { describe, expect, it } from 'vitest';

import { DISPLAY_UNITS_PARITY_FIXTURE } from '@stockpilot/core/testing/display-units';

import { buildGroupUnits, buildGroupedRows, type GroupableItem } from './inventory-grouping';

/**
 * Group selected (migration 0400) on the phone's Items and Books lists: the
 * same display rule as the web (core composeDisplayList), so the units the
 * phone pages are exactly the units the web pages (the shared fixture), an
 * explicit group with two or more records shows one header, and a lone member
 * keeps its context with a chip.
 */

function item(
  id: string,
  sku: string,
  name: string,
  over: Partial<GroupableItem> = {},
): GroupableItem {
  return {
    id,
    name,
    sku,
    quantity_on_hand: 1,
    reorder_point: 0,
    status: 'active',
    charter_id: null,
    primary_location_id: null,
    awaiting_first_receipt: false,
    ...over,
  };
}

const NONE = new Set<string>();

describe('buildGroupUnits: the shared parity fixture', () => {
  it('makes exactly the units the core keyer and the web make', () => {
    for (const c of DISPLAY_UNITS_PARITY_FIXTURE) {
      const rows = c.rows.map((r) =>
        item(r.id, r.sku, r.name, {
          quantity_on_hand: r.quantity_on_hand,
          charter_id: r.charter_id,
          group_id: r.group_id,
          variant_size: r.variant_size,
          display_group_id: r.display_group_id,
        }),
      );
      const units = buildGroupUnits(rows, { enableSizeRuns: c.sizeRuns }).map((u) =>
        u.map((r) => r.id),
      );
      expect({ name: c.name, units }).toEqual({ name: c.name, units: c.units });
    }
  });
});

describe('buildGroupedRows with explicit display groups', () => {
  const grouped = [
    item('a', 'POLO-A', 'Polo XXXL', {
      quantity_on_hand: 3,
      display_group_id: 'g',
      display_group_name: 'Polos',
    }),
    item('x', 'OTHER', 'Other'),
    item('b', 'POLO-B', 'Polo XXXL', {
      quantity_on_hand: 2,
      display_group_id: 'g',
      display_group_name: 'Polos',
    }),
  ];

  it('two records of a group make one header named for it, with each record counted once', () => {
    const rows = buildGroupedRows(grouped, { expandedSizeRuns: NONE, expandedSkuGroups: NONE });
    expect(rows.map((r) => r.kind)).toEqual(['explicit-header', 'row']);
    const head = rows[0]!;
    expect(head).toMatchObject({
      kind: 'explicit-header',
      groupId: 'g',
      name: 'Polos',
      recordCount: 2,
      total: 5,
      partial: false,
    });
  });

  it("expanding shows the group's own records under it, each keeping its SKU", () => {
    const rows = buildGroupedRows(grouped, {
      expandedSizeRuns: NONE,
      expandedSkuGroups: NONE,
      expandedExplicitGroups: new Set(['g']),
    });
    expect(rows.map((r) => (r.kind === 'row' ? r.item.id : r.kind))).toEqual([
      'explicit-header',
      'a',
      'b',
      'x',
    ]);
  });

  it('a group with ONE record present does not form; that record wears "In group <name>"', () => {
    const rows = buildGroupedRows([grouped[0]!, grouped[1]!], {
      expandedSizeRuns: NONE,
      expandedSkuGroups: NONE,
    });
    expect(rows.map((r) => r.kind)).toEqual(['row', 'row']);
    const lone = rows[0]!;
    expect(lone.kind === 'row' && lone.groupChip).toBe('In group Polos');
    // Already in the group: nothing to add it to.
    expect(lone.kind === 'row' && lone.addToGroupId).toBeNull();
  });

  it('a record in no group sharing a SKU with a group here says so', () => {
    const rows = buildGroupedRows(
      [
        item('a', 'PAD', 'Pad', { display_group_id: 'g', display_group_name: 'Pads' }),
        item('b', 'DESK', 'Desk', { display_group_id: 'g', display_group_name: 'Pads' }),
        item('c', 'PAD', 'Pad'),
      ],
      { expandedSizeRuns: NONE, expandedSkuGroups: NONE },
    );
    const c = rows.find((r) => r.kind === 'row' && r.item.id === 'c')!;
    expect(c.kind === 'row' && c.groupChip).toBe('Same SKU as records in Pads');
    // "Add to group" opens the review for THIS record and THAT group; nothing
    // joins a group by itself (owner decision: a new placement stays outside).
    expect(c.kind === 'row' && c.addToGroupId).toBe('g');
    const plain = rows.filter((r) => r.kind === 'row' && r.item.id !== 'c');
    for (const r of plain) expect(r.kind === 'row' && r.addToGroupId).toBeFalsy();
  });

  it('a group whose name could not be read still forms, as "Group"', () => {
    const rows = buildGroupedRows(
      [
        item('a', 'A', 'One', { display_group_id: 'g' }),
        item('b', 'B', 'Two', { display_group_id: 'g' }),
      ],
      { expandedSizeRuns: NONE, expandedSkuGroups: NONE },
    );
    expect(rows[0]).toMatchObject({ kind: 'explicit-header', name: 'Group' });
  });

  it('XS in a group stays its own record; the rest of its family still runs', () => {
    const rows = buildGroupedRows(
      [
        item('xs', 'T-XS', 'Tee - XS', {
          group_id: 'fam',
          variant_size: 'XS',
          display_group_id: 'g',
          display_group_name: 'Tees',
        }),
        item('s', 'T-S', 'Tee - S', { group_id: 'fam', variant_size: 'S' }),
        item('m', 'T-M', 'Tee - M', { group_id: 'fam', variant_size: 'M' }),
        item('k', 'K', 'Cap', { display_group_id: 'g', display_group_name: 'Tees' }),
      ],
      { expandedSizeRuns: NONE, expandedSkuGroups: NONE, expandedExplicitGroups: new Set(['g']) },
    );
    expect(rows.map((r) => (r.kind === 'row' ? r.item.id : r.kind))).toEqual([
      'explicit-header',
      'xs',
      'k',
      'header',
    ]);
  });

  it('Books never size-run, with or without groups', () => {
    const rows = buildGroupedRows(
      [item('a', 'B1', 'Earth Science - S'), item('b', 'B2', 'Earth Science - M')],
      { expandedSizeRuns: NONE, expandedSkuGroups: NONE, enableSizeRuns: false },
    );
    expect(rows.map((r) => r.kind)).toEqual(['row', 'row']);
  });
});
