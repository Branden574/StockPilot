import { describe, expect, it } from 'vitest';

import {
  applySage50Valuation,
  detectSage50Kind,
  mapSage50Items,
  mapSage50Valuation,
  mapSage50Vendors,
  parseSageBool,
  parseSageNumber,
} from './sage50';

describe('parseSageNumber', () => {
  it('strips currency formatting', () => {
    expect(parseSageNumber('$1,234.56')).toBe(1234.56);
    expect(parseSageNumber('  12.50 ')).toBe(12.5);
  });
  it('treats parentheses as negative (accounting style)', () => {
    expect(parseSageNumber('(45.00)')).toBe(-45);
    expect(parseSageNumber('($1,000.00)')).toBe(-1000);
  });
  it('returns 0 for blanks and junk', () => {
    expect(parseSageNumber(undefined)).toBe(0);
    expect(parseSageNumber('')).toBe(0);
    expect(parseSageNumber('N/A')).toBe(0);
  });
});

describe('parseSageBool', () => {
  it('accepts the TRUE/Yes/1 family', () => {
    expect(parseSageBool('TRUE')).toBe(true);
    expect(parseSageBool('Yes')).toBe(true);
    expect(parseSageBool('1')).toBe(true);
  });
  it('everything else is false', () => {
    expect(parseSageBool('FALSE')).toBe(false);
    expect(parseSageBool('')).toBe(false);
    expect(parseSageBool(undefined)).toBe(false);
  });
});

describe('detectSage50Kind', () => {
  it('detects the item list by Item ID + Item Class', () => {
    expect(detectSage50Kind(['Item ID', 'Item Description', 'Item Class'])).toBe('items');
  });
  it('detects the item list by cost/price columns', () => {
    expect(detectSage50Kind(['Item ID', 'Description', 'Last Unit Cost'])).toBe('items');
    expect(detectSage50Kind(['Item ID', 'Description', 'Sales Price 1'])).toBe('items');
  });
  it('detects the valuation report (qty/value columns, no Item Class)', () => {
    expect(detectSage50Kind(['Item ID', 'Item Description', 'Qty on Hand', 'Item Value'])).toBe(
      'valuation',
    );
    expect(detectSage50Kind(['Item ID', 'Avg Cost', 'Item Value'])).toBe('valuation');
  });
  it('item list WITH a quantity column still detects as items (Item Class wins)', () => {
    expect(
      detectSage50Kind(['Item ID', 'Item Class', 'Qty on Hand', 'Last Unit Cost']),
    ).toBe('items');
  });
  it('detects the vendor list', () => {
    expect(detectSage50Kind(['Vendor ID', 'Vendor Name', 'Telephone 1'])).toBe('vendors');
  });
  it('unknown for anything else', () => {
    expect(detectSage50Kind(['SKU', 'Title', 'Price'])).toBe('unknown');
  });
});

describe('mapSage50Items', () => {
  const header = [
    'Item ID',
    'Item Description',
    'Description for Sales',
    'Item Class',
    'Inactive',
    'Last Unit Cost',
    'Sales Price 1',
    'Stocking U/M',
    'Minimum Stock',
    'Reorder Quantity',
    'UPC / SKU',
    'Preferred Vendor ID',
  ];

  it('maps a full row', () => {
    const { items, skipped } = mapSage50Items(header, [
      [
        'BOOK-001',
        'Algebra Textbook',
        'Algebra I Student Edition',
        'Stock item',
        'FALSE',
        '$12.50',
        '$29.99',
        'Each',
        '5',
        '20',
        '012345678905',
        'ACME01',
      ],
    ]);
    expect(skipped).toHaveLength(0);
    expect(items[0]).toEqual({
      sku: 'BOOK-001',
      name: 'Algebra Textbook',
      description: 'Algebra I Student Edition',
      barcode: '012345678905',
      unit_cost: 12.5,
      retail_price: 29.99,
      quantity_on_hand: 0,
      reorder_point: 5,
      reorder_quantity: 20,
      unit_of_measure: 'Each',
      inactive: false,
      vendorId: 'ACME01',
    });
  });

  it('skips blank Item IDs and falls back name→sku', () => {
    const { items, skipped } = mapSage50Items(header, [
      ['', 'No id row', '', '', '', '', '', '', '', '', '', ''],
      ['SKU-2', '', '', '', 'TRUE', '', '', '', '', '', '', ''],
    ]);
    expect(skipped).toEqual([{ row: 2, reason: 'Blank Item ID' }]);
    expect(items[0]?.name).toBe('SKU-2');
    expect(items[0]?.inactive).toBe(true);
    expect(items[0]?.unit_of_measure).toBe('unit');
  });

  it('tolerates header variants (Price Level 1, plain Description)', () => {
    const { items } = mapSage50Items(
      ['Item ID', 'Description', 'Price Level 1'],
      [['X1', 'Widget', '9.99']],
    );
    expect(items[0]?.name).toBe('Widget');
    expect(items[0]?.retail_price).toBe(9.99);
  });

  it('clamps negative numerics to 0 and counts affected rows (one bad cell must never fail the import)', () => {
    const { items, clampedNegative } = mapSage50Items(
      ['Item ID', 'Item Description', 'Item Class', 'Qty on Hand', 'Last Unit Cost'],
      [
        ['A', 'Sold before received', 'Stock item', '(45.00)', '3.00'],
        ['B', 'Negative cost junk', 'Stock item', '10', '($1.00)'],
        ['C', 'Clean row', 'Stock item', '7', '2.50'],
      ],
    );
    expect(clampedNegative).toBe(2);
    expect(items[0]?.quantity_on_hand).toBe(0);
    expect(items[1]?.unit_cost).toBe(0);
    expect(items[1]?.quantity_on_hand).toBe(10);
    expect(items[2]?.quantity_on_hand).toBe(7);
    // every numeric the server schema requires nonnegative really is
    for (const it of items) {
      expect(it.quantity_on_hand).toBeGreaterThanOrEqual(0);
      expect(it.unit_cost).toBeGreaterThanOrEqual(0);
      expect(it.retail_price).toBeGreaterThanOrEqual(0);
      expect(it.reorder_point).toBeGreaterThanOrEqual(0);
      expect(it.reorder_quantity).toBeGreaterThanOrEqual(0);
    }
  });

  it('truncates over-long text fields to the import schema bounds', () => {
    const { items } = mapSage50Items(
      ['Item ID', 'Item Description', 'Description for Sales', 'Item Class'],
      [['LONG', 'n'.repeat(250), 'd'.repeat(2000), 'Stock item']],
    );
    expect(items[0]?.name).toHaveLength(200);
    expect(items[0]?.description).toHaveLength(1000);
  });
});

describe('mapSage50Valuation + applySage50Valuation', () => {
  it('overlays quantities and clamps negatives', () => {
    const valuation = mapSage50Valuation(
      ['Item ID', 'Item Description', 'Qty on Hand', 'Avg Cost', 'Item Value'],
      [
        ['A', 'Item A', '42', '3.10', '130.20'],
        ['B', 'Item B', '(5)', '2.00', '(10.00)'],
      ],
    );
    const items = mapSage50Items(
      ['Item ID', 'Item Description', 'Item Class'],
      [
        ['A', 'Item A', 'Stock item'],
        ['B', 'Item B', 'Stock item'],
        ['C', 'Item C', 'Stock item'],
      ],
    ).items;

    const { matched, clampedNegative } = applySage50Valuation(items, valuation);
    expect(matched).toBe(2);
    expect(clampedNegative).toBe(1);
    expect(items[0]?.quantity_on_hand).toBe(42);
    expect(items[0]?.unit_cost).toBe(3.1); // avg-cost fallback when item list had none
    expect(items[1]?.quantity_on_hand).toBe(0); // negative clamped
    expect(items[2]?.quantity_on_hand).toBe(0); // unmatched untouched
  });
});

describe('mapSage50Vendors', () => {
  it('maps vendors and skips blank ids', () => {
    const { vendors, skipped } = mapSage50Vendors(
      ['Vendor ID', 'Vendor Name', 'Contact', 'E-mail', 'Telephone 1'],
      [
        ['ACME01', 'Acme Supply Co', 'Jo Smith', 'jo@acme.com', '555-0100'],
        ['', 'Ghost vendor', '', '', ''],
        ['NONAME', '', '', '', ''],
      ],
    );
    expect(skipped).toEqual([{ row: 3, reason: 'Blank Vendor ID' }]);
    expect(vendors[0]).toEqual({
      vendorId: 'ACME01',
      name: 'Acme Supply Co',
      contactName: 'Jo Smith',
      email: 'jo@acme.com',
      phone: '555-0100',
    });
    expect(vendors[1]?.name).toBe('NONAME'); // name falls back to the id
  });

  it('nulls junk emails and truncates to the canonical supplier bounds', () => {
    const { vendors } = mapSage50Vendors(
      ['Vendor ID', 'Vendor Name', 'Contact', 'E-mail', 'Telephone 1'],
      [
        ['V1', 'x'.repeat(150), 'c'.repeat(150), 'not-an-email', '5'.repeat(60)],
        ['V2', 'Good Vendor', '', 'ok@vendor.com', ''],
      ],
    );
    expect(vendors[0]?.email).toBeNull();
    expect(vendors[0]?.name).toHaveLength(120);
    expect(vendors[0]?.contactName).toHaveLength(120);
    expect(vendors[0]?.phone).toHaveLength(40);
    expect(vendors[1]?.email).toBe('ok@vendor.com');
  });
});
