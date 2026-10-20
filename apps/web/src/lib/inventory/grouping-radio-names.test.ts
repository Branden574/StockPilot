import { describe, expect, it } from 'vitest';

import { GROUP_COPY, UNGROUP_COPY } from '@stockpilot/core';

import type { GroupingReviewRecord } from '@/server/services/item-grouping';

import { groupChoiceRadioNames, keepsSkuRadioLabel } from './grouping-radio-names';

/**
 * THE UNGROUP REVIEW'S "KEEPS THE SKU" RADIO NAMES (redesign Stage 6,
 * UNGROUP-WEB-RADIO-NAMES).
 *
 * When every record of a SKU the person can see is ticked, each of its rows
 * carries a radio for the one that keeps the SKU. Each radio was named "Keeps
 * SKU <sku>: <name>" and nothing more, so three Wireless Mouse records were
 * three radios with one name. Each name now goes on with what tells its
 * record apart from the SKU's other records, in the words of the record's
 * line, and "record N of M" when two still read the same.
 *
 * The phone made the same change (batch E, apps/mobile keepsSkuRadioLabel).
 * These cases and their expected words are the phone's own, so the web and
 * the phone say the same words for the same records.
 */

const M1 = 'dddddddd-0000-4000-8000-000000000001';
const M2 = 'dddddddd-0000-4000-8000-000000000002';
const M3 = 'dddddddd-0000-4000-8000-000000000003';
const OTHER = 'dddddddd-0000-4000-8000-000000000009';

const rec = (over: Partial<GroupingReviewRecord>): GroupingReviewRecord => ({
  id: M1,
  name: 'Wireless Mouse',
  sku: 'WM-1',
  barcode: null,
  isbnFields: null,
  itemType: 'product',
  isBundle: false,
  isRental: false,
  productGroupId: null,
  productGroupName: null,
  variantSize: null,
  charterId: null,
  warehouseId: null,
  binLocation: null,
  customFields: null,
  quantityOnHand: 4,
  createdAt: null,
  displayGroup: null,
  writable: true,
  charterName: null,
  warehouseName: 'Main',
  placementLabel: null,
  imageUrl: null,
  ...over,
});

const keeps = UNGROUP_COPY.keepsSku('WM-1');

/** Every radio's name for these records, all of them the SKU's radios. */
const names = (records: GroupingReviewRecord[], view: 'items' | 'books' = 'items') =>
  records.map((r) => keepsSkuRadioLabel(keeps, r, records, records, view));

describe('keepsSkuRadioLabel: each radio is named for what tells its record apart', () => {
  it('three Wireless Mouse records on three racks are three radios, each named with its rack', () => {
    const mice = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'C-3' }),
    ];
    expect(names(mice)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1',
      'Keeps SKU WM-1: Wireless Mouse, B-2',
      'Keeps SKU WM-1: Wireless Mouse, C-3',
    ]);
  });

  // The words are the line's own (core groupingRecordLine, the line the
  // dialog shows), and only the parts not on every one of the SKU's lines.
  it('says what differs, in the words of the record line: warehouse, charter, on hand, no rack', () => {
    expect(
      names([rec({ id: M1, warehouseName: 'Main' }), rec({ id: M2, warehouseName: 'Annex' })]),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse, Main', 'Keeps SKU WM-1: Wireless Mouse, Annex']);
    expect(
      names([
        rec({ id: M1, charterId: 'ch-1', charterName: 'North Charter' }),
        rec({ id: M2, charterId: null }),
      ]),
    ).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, North Charter',
      'Keeps SKU WM-1: Wireless Mouse, No charter',
    ]);
    expect(names([rec({ id: M1, quantityOnHand: 4 }), rec({ id: M2, quantityOnHand: 0 })])).toEqual(
      ['Keeps SKU WM-1: Wireless Mouse, 4 on hand', 'Keeps SKU WM-1: Wireless Mouse, 0 on hand'],
    );
    expect(
      names([
        rec({ id: M1, placementLabel: 'A-1', quantityOnHand: 4 }),
        rec({ id: M2, placementLabel: null, quantityOnHand: 4 }),
        rec({ id: M3, placementLabel: 'C-3', quantityOnHand: 0 }),
      ]),
    ).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1, 4 on hand',
      'Keeps SKU WM-1: Wireless Mouse, No rack, 4 on hand',
      'Keeps SKU WM-1: Wireless Mouse, C-3, 0 on hand',
    ]);
  });

  it('another name tells a record apart by itself; an ISBN or a size is said when it differs', () => {
    expect(
      names([
        rec({ id: M1, name: 'Wireless Mouse' }),
        rec({ id: M2, name: 'Wireless Mouse (black)' }),
      ]),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse', 'Keeps SKU WM-1: Wireless Mouse (black)']);
    expect(
      names([rec({ id: M1, variantSize: 'S' }), rec({ id: M2, variantSize: 'M' })], 'items'),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse, Size S', 'Keeps SKU WM-1: Wireless Mouse, Size M']);
    const editions = [
      rec({ id: M1, itemType: 'book', name: 'Atlas', barcode: '9780134685991' }),
      rec({ id: M2, itemType: 'book', name: 'Atlas', barcode: '9780321125217' }),
    ];
    expect(names(editions, 'books')).toEqual([
      'Keeps SKU WM-1: Atlas, ISBN 9780134685991',
      'Keeps SKU WM-1: Atlas, ISBN 9780321125217',
    ]);
  });

  // Mutation caught: a name with no position, so two records whose every
  // word reads the same are two radios with one name again.
  it('records whose names and lines read the same are told apart by where they are listed', () => {
    const twins = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'A-1' }),
    ];
    expect(names(twins)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1, record 1 of 3',
      'Keeps SKU WM-1: Wireless Mouse, B-2',
      'Keeps SKU WM-1: Wireless Mouse, A-1, record 3 of 3',
    ]);
    const same = [rec({ id: M1 }), rec({ id: M2 })];
    expect(names(same)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, record 1 of 2',
      'Keeps SKU WM-1: Wireless Mouse, record 2 of 2',
    ]);
  });

  // The SKU's radios are compared with each other, never with the review's
  // other rows; and the position is where the record is listed.
  it("compares only the SKU's records with a radio, in the order the review lists them", () => {
    const rows = [
      rec({ id: OTHER, name: 'Keyboard', sku: 'KB-1', warehouseName: 'Annex' }),
      rec({ id: M2 }),
      rec({ id: M1 }),
    ];
    const skuRecords = [{ id: M1 }, { id: M2 }];
    expect(keepsSkuRadioLabel(keeps, rows[2]!, rows, skuRecords, 'items')).toBe(
      'Keeps SKU WM-1: Wireless Mouse, record 2 of 2',
    );
    expect(keepsSkuRadioLabel(keeps, rows[1]!, rows, skuRecords, 'items')).toBe(
      'Keeps SKU WM-1: Wireless Mouse, record 1 of 2',
    );
  });

  it("starts as before, with core's choice and the record's name, and never says the outcome", () => {
    for (const name of names([rec({ id: M1, placementLabel: 'A-1' }), rec({ id: M2 })])) {
      expect(name.startsWith(`${UNGROUP_COPY.keepsSku('WM-1')}: Wireless Mouse`)).toBe(true);
      expect(name).not.toContain(UNGROUP_COPY.getsOwnSku);
      // The SKU is said once, by the choice; the shared line parts are not.
      expect(name.match(/WM-1/g)).toHaveLength(1);
      expect(name).not.toContain('Main');
    }
  });
});

/**
 * THE GROUP REVIEW'S "MOVE IT INTO THIS GROUP" AND "LEAVE IT OUT" RADIO NAMES
 * (redesign Stage 6, GROUP-REVIEW-RADIO-NAMES).
 *
 * A record already in another group gets two radios, named for the record
 * (recheck R2-5). Two records with one name that are both in another group
 * were radios with one name. By the Ungroup radios' rule, each name now goes
 * on with the words of the record's line that the other records with these
 * radios and the same name do not share, and "record N of M" when two still
 * read the same.
 */
describe('groupChoiceRadioNames: the Group review radios are named apart by the same rule', () => {
  const inH = { displayGroup: { id: 'h', name: 'Old shirts', version: 3 } };

  it("a record whose name is its own keeps core's words alone (R2-5)", () => {
    const rows = [
      rec({ id: M1, ...inH, name: 'Polo S', sku: 'P-S', placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, name: 'Polo M', sku: 'P-M', placementLabel: 'B-2' }),
    ];
    expect(rows.map((r) => groupChoiceRadioNames(r, rows, 'items'))).toEqual([
      { move: GROUP_COPY.moveOneFor('Polo S'), leave: GROUP_COPY.leaveOutOneFor('Polo S') },
      { move: GROUP_COPY.moveOneFor('Polo M'), leave: GROUP_COPY.leaveOutOneFor('Polo M') },
    ]);
  });

  it('three Wireless Mouse records on three racks: each pair is named with its rack; another name is not compared', () => {
    const rows = [
      rec({ id: M1, ...inH, placementLabel: 'A-1' }),
      rec({ id: OTHER, ...inH, name: 'Keyboard', sku: 'KB-1', warehouseName: 'Annex' }),
      rec({ id: M2, ...inH, placementLabel: 'B-2' }),
      rec({ id: M3, ...inH, placementLabel: 'C-3' }),
    ];
    expect(rows.map((r) => groupChoiceRadioNames(r, rows, 'items'))).toEqual([
      {
        move: 'Move it into this group: Wireless Mouse, A-1',
        leave: 'Leave it out: Wireless Mouse, A-1',
      },
      { move: 'Move it into this group: Keyboard', leave: 'Leave it out: Keyboard' },
      {
        move: 'Move it into this group: Wireless Mouse, B-2',
        leave: 'Leave it out: Wireless Mouse, B-2',
      },
      {
        move: 'Move it into this group: Wireless Mouse, C-3',
        leave: 'Leave it out: Wireless Mouse, C-3',
      },
    ]);
  });

  // Mutation caught: a name with no position, so two records whose every
  // word reads the same are two pairs of radios with one name again.
  it('two identical records end with where they are listed among the records with these radios', () => {
    const rows = [rec({ id: M2, ...inH }), rec({ id: M1, ...inH })];
    expect(rows.map((r) => groupChoiceRadioNames(r, rows, 'items'))).toEqual([
      {
        move: 'Move it into this group: Wireless Mouse, record 1 of 2',
        leave: 'Leave it out: Wireless Mouse, record 1 of 2',
      },
      {
        move: 'Move it into this group: Wireless Mouse, record 2 of 2',
        leave: 'Leave it out: Wireless Mouse, record 2 of 2',
      },
    ]);
  });

  it("says the SKU, an ISBN or a size when it is what differs, in the line's words", () => {
    const skus = [
      rec({ id: M1, ...inH, sku: 'WM-1' }),
      rec({ id: M2, ...inH, sku: 'WM-2', quantityOnHand: 0 }),
    ];
    expect(skus.map((r) => groupChoiceRadioNames(r, skus, 'items').move)).toEqual([
      'Move it into this group: Wireless Mouse, SKU WM-1, 4 on hand',
      'Move it into this group: Wireless Mouse, SKU WM-2, 0 on hand',
    ]);
    const editions = [
      rec({ id: M1, ...inH, itemType: 'book', name: 'Atlas', barcode: '9780134685991' }),
      rec({ id: M2, ...inH, itemType: 'book', name: 'Atlas', barcode: '9780321125217' }),
    ];
    expect(editions.map((r) => groupChoiceRadioNames(r, editions, 'books').leave)).toEqual([
      'Leave it out: Atlas, ISBN 9780134685991',
      'Leave it out: Atlas, ISBN 9780321125217',
    ]);
    const sizes = [
      rec({ id: M1, ...inH, variantSize: 'S' }),
      rec({ id: M2, ...inH, variantSize: 'M' }),
    ];
    expect(sizes.map((r) => groupChoiceRadioNames(r, sizes, 'items').move)).toEqual([
      'Move it into this group: Wireless Mouse, Size S',
      'Move it into this group: Wireless Mouse, Size M',
    ]);
  });
});
