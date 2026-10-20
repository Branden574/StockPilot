import { describe, expect, it } from 'vitest';

import { UNGROUP_COPY } from '@stockpilot/core';

import type { GroupingReviewRecord } from '@/server/services/item-grouping';

import { keepsSkuRadioLabel } from './grouping-radio-names';

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
