/**
 * The shared parity fixture for the display contract (design-merged.md 11):
 * one list of cases, each a set of item-level rows in list order and the
 * item-level units every surface must make of them. Core's keyer
 * (display-units.test.ts), the web's runAwarePages / planned page 1
 * (instant-mode.display-units.test.ts) and the phone's buildGroupUnits
 * (inventory-grouping.display-units.test.ts) all run it, so the three cannot
 * drift. Test data only: exported as '@stockpilot/core/testing/display-units',
 * never from the package index.
 */

export interface ParityRow {
  id: string;
  name: string;
  sku: string;
  charter_id: string | null;
  group_id: string | null;
  variant_size: string | null;
  display_group_id: string | null;
  quantity_on_hand: number;
}

export interface ParityCase {
  name: string;
  /** Size runs on (Items) or off (Books). */
  sizeRuns: boolean;
  rows: ParityRow[];
  /** The item-level units, in first-seen order. */
  units: string[][];
}

const r = (id: string, sku: string, name: string, over: Partial<ParityRow> = {}): ParityRow => ({
  id,
  sku,
  name,
  charter_id: null,
  group_id: null,
  variant_size: null,
  display_group_id: null,
  quantity_on_hand: 1,
  ...over,
});

export const DISPLAY_UNITS_PARITY_FIXTURE: readonly ParityCase[] = [
  {
    name: 'same SKU, same charter, different racks: one SKU family, no explicit group needed',
    sizeRuns: true,
    rows: [
      r('s1', 'SP-SAME', 'Mouse pad', { charter_id: 'chA' }),
      r('s2', 'SP-SAME', 'Mouse pad', { charter_id: 'chA' }),
      r('x', 'SP-OTHER', 'Other'),
    ],
    units: [['s1', 's2'], ['x']],
  },
  {
    name: "same charter and rack, different SKUs, grouped explicitly (the owner's polos)",
    sizeRuns: true,
    rows: [
      r('p1', 'SP-POLO-A', 'Polo XXXL', { display_group_id: 'gPolo' }),
      r('y', 'SP-Y', 'Something else'),
      r('p2', 'SP-POLO-B', 'Polo XXXL', { display_group_id: 'gPolo' }),
    ],
    units: [['p1', 'p2'], ['y']],
  },
  {
    name: 'no charter and mixed charters in one explicit group',
    sizeRuns: true,
    rows: [
      r('c1', 'C1', 'Charter north', { charter_id: 'chA', display_group_id: 'gMix' }),
      r('c2', 'C2', 'Charter south', { charter_id: 'chB', display_group_id: 'gMix' }),
      r('c3', 'C3', 'No charter', { display_group_id: 'gMix' }),
    ],
    units: [['c1', 'c2', 'c3']],
  },
  {
    name: 'one record on two racks is one item-level unit',
    sizeRuns: true,
    rows: [r('one', 'SP-ONE', 'Chromebook'), r('two', 'SP-TWO', 'Charger')],
    units: [['one'], ['two']],
  },
  {
    name: 'an XS to XXXXL run grouped explicitly: the group claims every size, sizes stay records',
    sizeRuns: true,
    rows: [
      r('xs', 'T-XS', 'Limits Tee - XS', {
        group_id: 'fam',
        variant_size: 'XS',
        display_group_id: 'gTee',
      }),
      r('s', 'T-S', 'Limits Tee - S', {
        group_id: 'fam',
        variant_size: 'S',
        display_group_id: 'gTee',
      }),
      r('xl', 'T-XL', 'Limits Tee - XL', {
        group_id: 'fam',
        variant_size: 'XL',
        display_group_id: 'gTee',
      }),
      r('xxxxl', 'T-4XL', 'Limits Tee - XXXXL', {
        group_id: 'fam',
        variant_size: 'XXXXL',
        display_group_id: 'gTee',
      }),
    ],
    units: [['xs', 's', 'xl', 'xxxxl']],
  },
  {
    name: 'a family plus an explicit group: grouped members leave the family run, the rest still run',
    sizeRuns: true,
    rows: [
      r('fxs', 'F-XS', 'Hoodie - XS', { group_id: 'fam2', variant_size: 'XS' }),
      r('fs', 'F-S', 'Hoodie - S', { group_id: 'fam2', variant_size: 'S', display_group_id: 'gH' }),
      r('fm', 'F-M', 'Hoodie - M', { group_id: 'fam2', variant_size: 'M' }),
      r('other', 'O-1', 'Scarf', { display_group_id: 'gH' }),
    ],
    units: [
      ['fxs', 'fm'],
      ['fs', 'other'],
    ],
  },
  {
    name: 'books with two ISBNs grouped explicitly; runs off',
    sizeRuns: false,
    rows: [
      r('b1', 'BK-1', 'Earth Science', { display_group_id: 'gBook' }),
      r('b2', 'BK-2', 'Earth Science', { display_group_id: 'gBook' }),
      r('b3', 'BK-3', 'Earth Science - S'),
    ],
    units: [['b1', 'b2'], ['b3']],
  },
  {
    name: 'a search hit on ONE member: the group does not form; the record keeps its own SKU family',
    sizeRuns: true,
    rows: [
      r('hit', 'SP-HIT', 'Polo XXXL', { display_group_id: 'gPolo' }),
      r('hit2', 'SP-HIT', 'Polo XXXL'),
    ],
    units: [['hit', 'hit2']],
  },
  {
    name: 'a partly grouped SKU: the claimed record leaves its SKU family, the rest stay together',
    sizeRuns: true,
    rows: [
      r('k1', 'SP-K', 'Pad', { display_group_id: 'gK' }),
      r('k2', 'SP-K', 'Pad'),
      r('k3', 'SP-K', 'Pad'),
      r('z', 'SP-Z', 'Desk', { display_group_id: 'gK' }),
    ],
    units: [
      ['k1', 'z'],
      ['k2', 'k3'],
    ],
  },
];
