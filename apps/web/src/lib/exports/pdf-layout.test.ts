import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';
import { REPORT_CELL_PADDING_PT } from '@/lib/pdf/column-fit';

import { getExportField, type InventoryExportFieldKey } from './field-registry';
import {
  computeExportPdfLayout,
  estimateExportPdfPages,
  IMAGE_CELL_PT,
  TOO_MANY_COLUMNS_THRESHOLD,
  tooManyColumnsWarning,
} from './pdf-layout';

const fields = (keys: InventoryExportFieldKey[]) => keys.map((k) => getExportField(k)!);

const BOOKS_DEFAULT: InventoryExportFieldKey[] = [
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
];

function layoutFor(keys: InventoryExportFieldKey[], overrides: Partial<Parameters<typeof computeExportPdfLayout>[0]> = {}) {
  return computeExportPdfLayout({
    fields: fields(keys),
    itemTypeKind: 'book',
    includeImages: keys.includes('image'),
    imageSize: 'medium',
    orientation: 'auto',
    paperSize: 'letter',
    density: 'comfortable',
    wrapText: true,
    layout: 'table',
    catalogColumns: 2,
    ...overrides,
  });
}

describe('computeExportPdfLayout — columns', () => {
  it('drops the image field from the column list and reserves a cell for it instead', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    expect(l.columns.map((c) => c.key)).not.toContain('image');
    expect(l.imageColumnWidthPt).toBe(IMAGE_CELL_PT.medium.widthPt);
  });

  it('reserves nothing when images are off', () => {
    const l = layoutFor(['name', 'sku', 'isbn']);
    expect(l.imageColumnWidthPt).toBe(0);
  });

  it('preserves the requested field order exactly', () => {
    const l = layoutFor(['status', 'isbn', 'name']);
    expect(l.columns.map((c) => c.key)).toEqual(['status', 'isbn', 'name']);
  });

  it('uses book headings — Title, not Name', () => {
    expect(layoutFor(['name']).columns[0]!.label).toBe('Title');
    expect(
      computeExportPdfLayout({
        fields: fields(['name']),
        itemTypeKind: 'other',
        includeImages: false,
        imageSize: 'medium',
        orientation: 'auto',
        paperSize: 'letter',
        density: 'comfortable',
        wrapText: true,
        layout: 'table',
        catalogColumns: 2,
      }).columns[0]!.label,
    ).toBe('Name');
  });

  it('fits every header inside its own column box for the full Books default set', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    for (const col of l.columns) {
      const shown = col.label.toUpperCase();
      const needed = width(shown, 'Helvetica-Bold', 8) + shown.length * 0.4;
      const box = col.widthPt - REPORT_CELL_PADDING_PT * 2;
      expect(needed <= box, `${col.label}: needs ${needed.toFixed(2)}pt, box ${box.toFixed(2)}pt`).toBe(
        true,
      );
    }
  });

  it('never sums the columns plus the image cell past the content width', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    const total = l.columns.reduce((sum, c) => sum + c.widthPt, 0) + l.imageColumnWidthPt;
    expect(total).toBeLessThanOrEqual(l.contentWidthPt + 1e-6);
  });

  it('keeps ISBN at its readable minimum even in the widest field set', () => {
    const l = layoutFor([...BOOKS_DEFAULT, 'barcode', 'warehouse', 'supplier', 'charter']);
    const isbn = l.columns.find((c) => c.key === 'isbn')!;
    expect(isbn.widthPt).toBeGreaterThanOrEqual(60);
    expect(isbn.wrap).toBe(false);
  });
});

describe('computeExportPdfLayout — orientation', () => {
  it('picks portrait for a short, imageless field set', () => {
    expect(layoutFor(['name', 'isbn', 'sku']).orientation).toBe('portrait');
  });

  it('picks landscape for the 12-field Books default', () => {
    expect(layoutFor(BOOKS_DEFAULT).orientation).toBe('landscape');
  });

  it('honours an explicit choice over auto', () => {
    expect(layoutFor(BOOKS_DEFAULT, { orientation: 'portrait' }).orientation).toBe('portrait');
    expect(layoutFor(['name'], { orientation: 'landscape' }).orientation).toBe('landscape');
  });

  it('gives Legal its extra length in portrait and extra width in landscape', () => {
    const portrait = layoutFor(['name', 'isbn'], { paperSize: 'legal', orientation: 'portrait' });
    expect(portrait.pageHeightPt).toBe(1008);
    const landscape = layoutFor(BOOKS_DEFAULT, { paperSize: 'legal', orientation: 'landscape' });
    expect(landscape.pageWidthPt).toBe(1008);
    expect(landscape.contentWidthPt).toBeGreaterThan(
      layoutFor(BOOKS_DEFAULT, { paperSize: 'letter', orientation: 'landscape' }).contentWidthPt,
    );
  });

  it('keeps a 1 or 2 column catalog portrait and a 3 column catalog landscape', () => {
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 1 }).orientation).toBe(
      'portrait',
    );
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 2 }).orientation).toBe(
      'portrait',
    );
    expect(layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 3 }).orientation).toBe(
      'landscape',
    );
  });
});

describe('computeExportPdfLayout — rows', () => {
  it('grows the row for images, by size tier', () => {
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'small' }).rowHeightPt).toBe(28);
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'medium' }).rowHeightPt).toBe(44);
    expect(layoutFor(BOOKS_DEFAULT, { imageSize: 'large' }).rowHeightPt).toBe(64);
  });

  it('keeps rows compact when images are off', () => {
    const l = layoutFor(['name', 'sku'], { density: 'compact' });
    expect(l.rowHeightPt).toBeLessThan(24);
    expect(l.imageColumnWidthPt).toBe(0);
  });

  it('gives image-friendly density more padding than compact', () => {
    expect(layoutFor(['name'], { density: 'image-friendly' }).rowPaddingPt).toBeGreaterThan(
      layoutFor(['name'], { density: 'compact' }).rowPaddingPt,
    );
  });

  it('estimates fewer rows per page for taller rows', () => {
    const small = layoutFor(BOOKS_DEFAULT, { imageSize: 'small' });
    const large = layoutFor(BOOKS_DEFAULT, { imageSize: 'large' });
    expect(large.estimatedRowsPerPage).toBeLessThan(small.estimatedRowsPerPage);
    expect(large.estimatedRowsPerPage).toBeGreaterThan(0);
  });
});

describe('computeExportPdfLayout — warnings', () => {
  it('stays silent for a sane field set', () => {
    expect(layoutFor(BOOKS_DEFAULT).warnings).toEqual([]);
    expect(layoutFor(BOOKS_DEFAULT).overflow).toBe(false);
  });

  it('warns with the exact brief copy once the column count crosses the threshold', () => {
    const many = layoutFor([
      'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
      'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
      'charter', 'item_type',
    ]);
    expect(many.warnings.some((w) => w.includes('may be difficult to read'))).toBe(true);
    expect(many.warnings[0]).toBe(tooManyColumnsWarning(many.columns.length));
  });

  it('formats the warning with the real column count and the brief wording', () => {
    expect(tooManyColumnsWarning(16)).toBe(
      'This PDF contains 16 columns and may be difficult to read. Remove fields, use Legal paper, or export to Excel for the complete dataset.',
    );
    expect(TOO_MANY_COLUMNS_THRESHOLD).toBe(12);
  });

  it('flags overflow when the minimums cannot fit, and still returns usable widths', () => {
    const l = layoutFor(
      [
        'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
        'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
        'charter', 'item_type', 'tracking_type', 'reorder_point', 'reorder_quantity',
        'unit_cost', 'retail_price', 'inventory_value', 'created_at', 'updated_at',
      ],
      { orientation: 'portrait', paperSize: 'letter', imageSize: 'large' },
    );
    expect(l.overflow).toBe(true);
    for (const col of l.columns) expect(col.widthPt).toBeGreaterThan(0);
    // Never blocks: the brief says block only when nothing readable is possible.
    expect(l.columns).toHaveLength(24);
  });
});

describe('estimateExportPdfPages', () => {
  it('is a labelled range, never a single fake number', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    const est = estimateExportPdfPages(l, 111);
    expect(est.min).toBeGreaterThan(0);
    expect(est.max).toBeGreaterThanOrEqual(est.min);
  });

  it('returns one page for an empty or tiny export', () => {
    const l = layoutFor(BOOKS_DEFAULT);
    expect(estimateExportPdfPages(l, 0)).toEqual({ min: 1, max: 1 });
    expect(estimateExportPdfPages(l, 3).min).toBe(1);
  });

  it('divides by the catalog column count for catalog layouts', () => {
    const l = layoutFor(BOOKS_DEFAULT, { layout: 'catalog', catalogColumns: 3 });
    const one = estimateExportPdfPages(l, 90, { catalogColumns: 1 });
    const three = estimateExportPdfPages(l, 90, { catalogColumns: 3 });
    expect(three.max).toBeLessThan(one.max);
  });
});
