import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from './field-registry';
import type { InventoryExportSourceRow } from './source-row';
import { toInventoryCsv } from './export-csv';

const fieldsFor = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42.5,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: null,
    // Legacy-only (see source-row.ts) — this module never reads it, but the
    // row shape requires it. DEVIATION from the brief's verbatim test (task-12
    // brief): the brief's makeRow() omitted this required field, which fails
    // typecheck against InventoryExportSourceRow (legacyRawBookFields is
    // non-optional). Same convention already used by
    // inventory-export-xlsx.test.ts, field-registry.test.ts and
    // export-images.test.ts.
    legacyRawBookFields: {
      grade: 'College',
      rackNumber: '38',
      rackRow: 'A',
      crateColor: 'blue',
      crateNumber: '12',
    },
    ...overrides,
  };
}

const lines = (csv: string) => csv.split('\n');

describe('toInventoryCsv', () => {
  it('writes friendly headings for the selected fields, in the chosen order', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['status', 'isbn', 'name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[0]).toBe('Status,ISBN,Title');
    expect(lines(csv)[1]).toBe('active,9780262033848,Introduction to Algorithms');
  });

  it('labels the image column Image URL — never "images", never binary', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'image']),
      rows: [makeRow({ image: { thumbnailUrl: 'https://signed.example/a.jpg' } })],
      itemTypeKind: 'book',
    });
    // DEVIATION from the brief's verbatim expectation (task-12 brief): the
    // brief asserts 'Name,Image URL' here, but fieldHeading (field-registry.ts,
    // already shipped in Task 4 and pinned by field-registry.test.ts's "calls
    // the name column Title for books and Name for items") turns the `name`
    // field into 'Title' whenever itemType is 'book', independent of format.
    // itemTypeKind: 'book' is passed in this very test, so the real, correct
    // output is 'Title,Image URL'. Fixing the shipped, already-tested
    // field-registry contract to match a wrong brief literal would be the bug;
    // fixing the literal is the second brief defect found in this task,
    // alongside the known makeRow() fixture omission.
    expect(lines(csv)[0]).toBe('Title,Image URL');
    expect(lines(csv)[1]).toContain('https://signed.example/a.jpg');
    expect(csv).not.toContain('base64');
  });

  it('leaves the image column blank for a row with no image', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['sku', 'image']),
      rows: [makeRow({ image: null })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('BK-0001,');
  });

  it('quotes values containing commas, quotes and newlines', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow({ name: 'Algorithms, 4th ed. "Deluxe"\nSecond line' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toContain('"Algorithms, 4th ed. ""Deluxe""');
  });

  it('defuses formula injection', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'sku']),
      rows: [makeRow({ name: '=cmd|calc', sku: '+1+1' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]!.startsWith("'=cmd|calc")).toBe(true);
    expect(lines(csv)[1]).toContain("'+1+1");
  });

  it('keeps a leading-zero ISBN intact and never quotes it into a number', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['isbn']),
      rows: [makeRow({ isbn: '0262033844' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('0262033844');
  });

  it('writes an empty cell — never the word undefined — for a missing value', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'author', 'grade']),
      rows: [makeRow({ author: '', grade: '' })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('Introduction to Algorithms,,');
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('[object Object]');
  });

  it('writes a real zero as 0', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['sku', 'quantity_on_hand']),
      rows: [makeRow({ quantityOnHand: 0 })],
      itemTypeKind: 'book',
    });
    expect(lines(csv)[1]).toBe('BK-0001,0');
  });

  it('writes no BOM — existing consumers read BOM-less UTF-8 today', () => {
    // Brief section 15 asks for UTF-8 with a BOM only after verifying current
    // consumers. Nothing in this repo writes one, so adding one silently would
    // be a behaviour change to every existing importer. Documented, not done.
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
    });
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('appends the truncation note as a comment line when the cap was hit', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name']),
      rows: [makeRow()],
      itemTypeKind: 'book',
      truncatedNote: '# truncated at 10000 rows of 41230',
    });
    expect(lines(csv).at(-1)).toBe('# truncated at 10000 rows of 41230');
  });

  it('still writes a header row for an empty result set', () => {
    const csv = toInventoryCsv({
      fields: fieldsFor(['name', 'sku']),
      rows: [],
      itemTypeKind: 'other',
    });
    expect(csv).toBe('Name,SKU');
  });
});
