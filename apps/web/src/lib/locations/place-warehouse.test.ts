import { describe, expect, it } from 'vitest';

import {
  bulkPlaceJoinWarehouseNote,
  bulkPlaceWarehouseScope,
  initialPlaceWarehouse,
  placeWarehouseOptions,
  sharedItemWarehouse,
  stagingRowPlaceable,
} from './place-warehouse';

const MAIN = { id: 'wh-main', name: 'Main Warehouse' };
const ANNEX = { id: 'wh-annex', name: 'Annex' };

describe('placeWarehouseOptions', () => {
  it('lists the page warehouses by name, whatever order the map arrived in', () => {
    expect(placeWarehouseOptions({ 'wh-main': 'Main Warehouse', 'wh-annex': 'Annex' })).toEqual([
      ANNEX,
      MAIN,
    ]);
    expect(placeWarehouseOptions({})).toEqual([]);
  });
});

describe('initialPlaceWarehouse', () => {
  it("opens on the item's own warehouse when it is offered", () => {
    expect(initialPlaceWarehouse([ANNEX, MAIN], 'wh-main')).toBe('wh-main');
  });

  it("never opens on a warehouse that is not offered (the item's is not one the viewer can place into)", () => {
    expect(initialPlaceWarehouse([ANNEX, MAIN], 'wh-elsewhere')).toBe('');
    expect(initialPlaceWarehouse([MAIN], 'wh-elsewhere')).toBe('wh-main');
  });

  it('opens on the only warehouse offered, and on none when there are several and no preference', () => {
    expect(initialPlaceWarehouse([MAIN], null)).toBe('wh-main');
    expect(initialPlaceWarehouse([ANNEX, MAIN], null)).toBe('');
    expect(initialPlaceWarehouse([], 'wh-main')).toBe('');
  });
});

describe('stagingRowPlaceable', () => {
  it('a row with a warehouse is placeable by anyone who may place', () => {
    expect(stagingRowPlaceable({ warehouseId: 'wh-main' }, true, [])).toBe(true);
    expect(stagingRowPlaceable({ warehouseId: 'wh-main' }, false, [MAIN])).toBe(false);
  });

  it('a row with no warehouse is placeable when there is a warehouse to choose (B38)', () => {
    expect(stagingRowPlaceable({ warehouseId: null }, true, [MAIN])).toBe(true);
    expect(stagingRowPlaceable({ warehouseId: null }, true, [])).toBe(false);
    expect(stagingRowPlaceable({ warehouseId: null }, false, [MAIN])).toBe(false);
  });
});

describe('bulkPlaceWarehouseScope', () => {
  it('one warehouse among the rows decides; rows with none join it', () => {
    expect(
      bulkPlaceWarehouseScope([{ warehouseId: 'wh-main' }, { warehouseId: 'wh-main' }]),
    ).toEqual({
      kind: 'one',
      warehouseId: 'wh-main',
    });
    expect(bulkPlaceWarehouseScope([{ warehouseId: null }, { warehouseId: 'wh-main' }])).toEqual({
      kind: 'one',
      warehouseId: 'wh-main',
    });
  });

  it('no row with a warehouse: the person chooses one', () => {
    expect(bulkPlaceWarehouseScope([{ warehouseId: null }, { warehouseId: null }])).toEqual({
      kind: 'choose',
    });
  });

  it('rows from two warehouses are refused, with or without rows that have none', () => {
    expect(
      bulkPlaceWarehouseScope([{ warehouseId: 'wh-main' }, { warehouseId: 'wh-annex' }]),
    ).toEqual({
      kind: 'several',
    });
    expect(
      bulkPlaceWarehouseScope([
        { warehouseId: null },
        { warehouseId: 'wh-main' },
        { warehouseId: 'wh-annex' },
      ]),
    ).toEqual({ kind: 'several' });
  });
});

describe('sharedItemWarehouse', () => {
  it('the item warehouse every row with no warehouse shares', () => {
    expect(
      sharedItemWarehouse([
        { warehouseId: null, itemWarehouseId: 'wh-main' },
        { warehouseId: null, itemWarehouseId: 'wh-main' },
        // A row with its own warehouse does not vote.
        { warehouseId: 'wh-annex', itemWarehouseId: 'wh-annex' },
      ]),
    ).toBe('wh-main');
  });

  it('none when they differ, when one is unknown, or when no row lacks a warehouse', () => {
    expect(
      sharedItemWarehouse([
        { warehouseId: null, itemWarehouseId: 'wh-main' },
        { warehouseId: null, itemWarehouseId: 'wh-annex' },
      ]),
    ).toBeNull();
    expect(
      sharedItemWarehouse([
        { warehouseId: null, itemWarehouseId: 'wh-main' },
        { warehouseId: null },
      ]),
    ).toBeNull();
    expect(
      sharedItemWarehouse([{ warehouseId: 'wh-main', itemWarehouseId: 'wh-main' }]),
    ).toBeNull();
  });
});

describe('bulkPlaceJoinWarehouseNote', () => {
  it('names how many rows join the warehouse', () => {
    expect(bulkPlaceJoinWarehouseNote(1, 'Main Warehouse')).toBe(
      '1 selected row is not in any warehouse yet and goes to Main Warehouse too.',
    );
    expect(bulkPlaceJoinWarehouseNote(3, 'Main Warehouse')).toBe(
      '3 selected rows are not in any warehouse yet and go to Main Warehouse too.',
    );
  });
});
