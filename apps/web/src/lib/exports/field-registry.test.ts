import { describe, expect, it } from 'vitest';

import { REPORT_CELL_PADDING_PT } from '../pdf/column-fit';
import { REPORT_BODY_FONT_SIZE_PT } from '../pdf/report-table';
import { width } from '@/test/pdf-font-metrics';

import type { InventoryExportSourceRow } from './source-row';
import {
  BOOKS_DEFAULT_FIELD_KEYS,
  defaultFieldKeysFor,
  EXPORT_FIELDS,
  fieldHeading,
  getExportField,
  IDENTIFYING_FIELD_KEYS,
  ITEMS_DEFAULT_FIELD_KEYS,
} from './field-registry';

function makeRow(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 2,
    reorderQuantity: 6,
    unitCost: 42.5,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: 'Ingram',
    warehouse: 'North Region',
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
    ...overrides,
  };
}

describe('EXPORT_FIELDS — shape', () => {
  it('has no duplicate keys', () => {
    const keys = EXPORT_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every field a non-empty label and at least one supported format', () => {
    for (const f of EXPORT_FIELDS) {
      expect(f.label.length, `${f.key} has no label`).toBeGreaterThan(0);
      expect(
        f.csvSupported || f.xlsxSupported || f.pdfSupported,
        `${f.key} is supported by no format`,
      ).toBe(true);
    }
  });

  it('gives every PDF-capable field a positive point minimum', () => {
    for (const f of EXPORT_FIELDS) {
      if (!f.pdfSupported) continue;
      // pdfMinWidth is the hard floor: every rendered column must claim real
      // space, no exceptions.
      expect(f.pdfMinWidth, `${f.key} has no pdfMinWidth`).toBeGreaterThan(0);
      // pdfWidth is only the RELATIVE WEIGHT for sharing surplus (see the
      // interface doc comment) — `image` deliberately declares 0 so it never
      // grows past its fixed thumbnail floor (fitColumnWidths in
      // ../pdf/column-fit.ts locks any 0-weight column at its minWidth on the
      // very first allocation pass, exactly like the fixed 22pt image-column
      // reserve report-table-fit.test.ts already exercises). So the real
      // invariant is "defined and non-negative", not "positive".
      expect(f.pdfWidth, `${f.key} has a negative pdfWidth`).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks financial fields as a group so a future permission can gate them at one point', () => {
    const financial = EXPORT_FIELDS.filter((f) => f.group === 'financial').map((f) => f.key);
    expect(financial).toEqual(['unit_cost', 'retail_price', 'inventory_value']);
    // OWNER DECISION OPEN: no cost-visibility permission exists in this
    // codebase (audit B6), so nothing is gated today and these are available
    // to items:export holders exactly as they are on the item detail page.
    // The slot exists so introducing one is a one-line change.
    for (const key of financial) {
      expect(getExportField(key)!.permission).toBeUndefined();
    }
  });
});

describe('defaults', () => {
  it('the Books default includes ISBN, in the brief order', () => {
    expect([...BOOKS_DEFAULT_FIELD_KEYS]).toEqual([
      'image',
      'name',
      'isbn',
      'sku',
      'author',
      'grade',
      'quantity_on_hand',
      'category',
      'rack',
      'crate',
      'primary_location',
      'status',
    ]);
  });

  it('the Items default excludes every book-only field AND the image', () => {
    // Brief section 9: Items PDF images default OFF. Books covers default ON.
    expect(ITEMS_DEFAULT_FIELD_KEYS).not.toContain('image');
    for (const key of ITEMS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)!.appliesTo, `${key} is book-only`).toBe('all');
    }
    expect([...ITEMS_DEFAULT_FIELD_KEYS]).toEqual([
      'name',
      'sku',
      'barcode',
      'quantity_on_hand',
      'category',
      'primary_location',
      'warehouse',
      'supplier',
      'charter',
      'status',
    ]);
  });

  it('every default key exists in the registry and its flag agrees with the list', () => {
    for (const key of BOOKS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)?.defaultForBooks, `${key} flag disagrees`).toBe(true);
    }
    for (const key of ITEMS_DEFAULT_FIELD_KEYS) {
      expect(getExportField(key)?.defaultForItems, `${key} flag disagrees`).toBe(true);
    }
    expect(EXPORT_FIELDS.filter((f) => f.defaultForBooks).length).toBe(
      BOOKS_DEFAULT_FIELD_KEYS.length,
    );
    expect(EXPORT_FIELDS.filter((f) => f.defaultForItems).length).toBe(
      ITEMS_DEFAULT_FIELD_KEYS.length,
    );
  });

  it('defaultFieldKeysFor returns a fresh mutable copy each call', () => {
    const a = defaultFieldKeysFor('book');
    a.push('status');
    expect(defaultFieldKeysFor('book')).toEqual([...BOOKS_DEFAULT_FIELD_KEYS]);
  });

  it('every default set contains at least one identifying field', () => {
    for (const set of [BOOKS_DEFAULT_FIELD_KEYS, ITEMS_DEFAULT_FIELD_KEYS]) {
      expect(set.some((k) => IDENTIFYING_FIELD_KEYS.includes(k))).toBe(true);
    }
  });
});

describe('headings', () => {
  it('calls the name column Title for books and Name for items', () => {
    const name = getExportField('name')!;
    expect(fieldHeading(name, { format: 'pdf', itemType: 'book' })).toBe('Title');
    expect(fieldHeading(name, { format: 'pdf', itemType: 'other' })).toBe('Name');
  });

  it('calls the image column Image URL in CSV — never "Include images", never binary', () => {
    const image = getExportField('image')!;
    expect(fieldHeading(image, { format: 'csv', itemType: 'book' })).toBe('Image URL');
    expect(fieldHeading(image, { format: 'csv', itemType: 'other' })).toBe('Image URL');
  });

  it('calls the image column Cover for books and Image for items in PDF and Excel', () => {
    const image = getExportField('image')!;
    expect(fieldHeading(image, { format: 'pdf', itemType: 'book' })).toBe('Cover');
    expect(fieldHeading(image, { format: 'xlsx', itemType: 'book' })).toBe('Cover');
    expect(fieldHeading(image, { format: 'pdf', itemType: 'other' })).toBe('Image');
  });

  it('is a friendly label, never the raw column key', () => {
    for (const f of EXPORT_FIELDS) {
      const heading = fieldHeading(f, { format: 'csv', itemType: 'book' });
      expect(heading).not.toContain('_');
      expect(heading[0]).toBe(heading[0]!.toUpperCase());
    }
  });
});

describe('value extraction', () => {
  it('reads plain fields off the source row', () => {
    const row = makeRow();
    expect(getExportField('name')!.value(row)).toBe('Introduction to Algorithms');
    expect(getExportField('quantity_on_hand')!.value(row)).toBe(4);
    expect(getExportField('charter')!.value(row)).toBe('Generic');
  });

  it('keeps ISBN a string, leading zeroes intact', () => {
    const v = getExportField('isbn')!.value(makeRow({ isbn: '0262033844' }));
    expect(v).toBe('0262033844');
    expect(typeof v).toBe('string');
  });

  it('renders a missing ISBN as an empty string, never undefined or null', () => {
    const v = getExportField('isbn')!.value(makeRow({ isbn: '' }));
    expect(v).toBe('');
  });

  it('renders the combined rack and crate labels the list page already computes', () => {
    const row = makeRow();
    expect(getExportField('rack')!.value(row)).toBe('38-A');
    expect(getExportField('crate')!.value(row)).toBe('Blue 12');
    expect(getExportField('rack_number')!.value(row)).toBe('38');
    expect(getExportField('crate_color')!.value(row)).toBe('blue');
  });

  it('computes inventory value from unit cost and quantity, and 0 when cost is unknown', () => {
    expect(getExportField('inventory_value')!.value(makeRow())).toBe(170);
    expect(getExportField('inventory_value')!.value(makeRow({ unitCost: null }))).toBe(0);
  });

  it('returns the image thumbnail URL only when one was resolved', () => {
    expect(getExportField('image')!.value(makeRow())).toBe('');
    expect(
      getExportField('image')!.value(
        makeRow({ image: { thumbnailUrl: 'https://signed.example/thumb.webp' } }),
      ),
    ).toBe('https://signed.example/thumb.webp');
  });

  it('never emits undefined, null or [object Object] for any field on a sparse row', () => {
    const sparse = makeRow({
      author: '',
      isbn: '',
      grade: '',
      rackLabel: '',
      crateLabel: '',
      unitCost: null,
      retailPrice: null,
      image: null,
    });
    for (const f of EXPORT_FIELDS) {
      const v = f.value(sparse);
      expect(v, `${f.key} produced ${String(v)}`).not.toBeUndefined();
      expect(v, `${f.key} produced null`).not.toBeNull();
      expect(String(v)).not.toBe('[object Object]');
    }
  });
});

describe('isbn pdf width — regression guard for the ISBN truncation bug', () => {
  // Phase A (Task 1's fix-wave, then Task 3) found that a naive 13-digit
  // ISBN-13 measurement undercounts the real worst case: inventory_items.barcode
  // has no digit-only guard anywhere a human can type it, so a person typing the
  // ISBN exactly as printed on a book's back cover ("978-1-234-56789-7", the
  // standard 5-group hyphenation, 13 digits + 4 hyphens = 17 characters) saves
  // it verbatim — and the isbn column is wrap:false, so an undersized floor
  // truncates or wraps into a garbled second line instead of shrinking.
  // inventory-pdf-columns.ts fixed BOOKS_PDF_COLUMNS to a value-derived
  // minWidth of 81; this test holds field-registry.ts's isbn field to the same
  // real floor so a future consumer of EXPORT_FIELDS (Tasks 5-16 import this
  // registry directly) cannot silently regress back to a header-only guess.
  const WORST_CASE_ISBN_VALUE = '978-1-234-56789-7';

  it('holds the isbn pdfMinWidth to the value-derived floor, not just the 4-letter header', () => {
    const isbn = getExportField('isbn')!;
    const box = isbn.pdfMinWidth - REPORT_CELL_PADDING_PT * 2;
    const needed = width(WORST_CASE_ISBN_VALUE, 'Helvetica', REPORT_BODY_FONT_SIZE_PT);
    expect(
      needed,
      `isbn pdfMinWidth ${isbn.pdfMinWidth} gives a ${box.toFixed(2)}pt box but the worst-case ISBN needs ${needed.toFixed(2)}pt`,
    ).toBeLessThanOrEqual(box);
  });
});
