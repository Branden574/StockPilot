import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';
import { REPORT_CELL_PADDING_PT } from '@/lib/pdf/column-fit';
import {
  REPORT_BODY_FONT_SIZE_PT,
  REPORT_HEADER_FONT_SIZE_PT,
  REPORT_HEADER_LETTER_SPACING_PT,
} from '@/lib/pdf/report-table';

import {
  BOOKS_DEFAULT_FIELD_KEYS,
  getExportField,
  ITEMS_DEFAULT_FIELD_KEYS,
  type InventoryExportFieldKey,
} from './field-registry';
import {
  computeExportPdfLayout,
  estimateExportPdfPages,
  IMAGE_CELL_PT,
  TOO_MANY_COLUMNS_THRESHOLD,
  tooManyColumnsWarning,
  type ExportImageSize,
  type PdfOrientation,
} from './pdf-layout';

/** Same formula the three permanent fit nets use (report-headers-fit.test.ts,
 *  export-pdf-headers-fit.test.ts, registry-preset-fit.test.ts): Helvetica-Bold
 *  advance widths at REPORT_HEADER_FONT_SIZE_PT, uppercase, plus letter
 *  spacing per character — @react-pdf applies textTransform before measuring. */
function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

/** Width of a rendered BODY cell value — plain Helvetica, no uppercase, no
 *  letter spacing (matches valueWidth in export-pdf-headers-fit.test.ts). */
function valueWidth(value: string): number {
  return width(value, 'Helvetica', REPORT_BODY_FONT_SIZE_PT);
}

/**
 * The worst-case ISBN value the isbn column must never truncate (Brief
 * section 11: "NEVER truncate ISBN"). Same derivation as field-registry.ts's
 * isbn.pdfMinWidth comment and export-pdf-headers-fit.test.ts's
 * WORST_CASE_ISBN_VALUE: inventory_items.barcode has no digit-only guard
 * anywhere a human can type it, so a person typing the ISBN exactly as
 * printed on a book's back cover ("978-1-234-56789-7", 13 digits + 4
 * hyphens = 17 characters) saves it verbatim.
 */
const WORST_CASE_ISBN_VALUE = '978-1-234-56789-7';

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

/**
 * CRITICAL 1 (Task 8 review): the existing "fits every header" test above
 * only ever exercises `orientation: 'auto'` at `imageSize: 'medium'`, which
 * resolves to landscape for the 12-field Books default — it never once
 * calls the function with `orientation: 'portrait'`, the exact input that
 * reproduces the ON HAND/CATEGORY header collision (grade -7.15pt,
 * quantity_on_hand -8.76pt, category -10.31pt, rack -0.20pt, crate -2.00pt,
 * primary_location -6.75pt, status -5.32pt against their header boxes, at
 * imageSize large — same overflow at small/medium, so it's orientation-
 * driven, not image-size-driven). Portrait is one of the three orientations
 * Brief section 11 exposes (`'auto' | 'portrait' | 'landscape'`), applied to
 * the registry's own unmodified default preset — an ordinary input.
 *
 * This suite sweeps every imageSize x orientation combination (3 x 3) for
 * BOTH default presets through the REAL `computeExportPdfLayout`, and
 * requires one of two outcomes for every header: it fits its content box, OR
 * the layout honestly reports `overflow: true` with a warning that NAMES the
 * offending columns. A layout that silently overflows with no warning, or a
 * warning that never says which columns, is the exact failure this program
 * exists to prevent.
 */
describe('computeExportPdfLayout — header fit across every image size x orientation (Brief section 11)', () => {
  const IMAGE_SIZES: ExportImageSize[] = ['small', 'medium', 'large'];
  const ORIENTATIONS: Array<'auto' | PdfOrientation> = ['auto', 'portrait', 'landscape'];

  const PRESETS: Record<
    string,
    { keys: readonly InventoryExportFieldKey[]; itemType: 'book' | 'other' }
  > = {
    'BOOKS_DEFAULT_FIELD_KEYS (books)': { keys: BOOKS_DEFAULT_FIELD_KEYS, itemType: 'book' },
    'ITEMS_DEFAULT_FIELD_KEYS (items)': { keys: ITEMS_DEFAULT_FIELD_KEYS, itemType: 'other' },
  };

  for (const [presetLabel, { keys, itemType }] of Object.entries(PRESETS)) {
    for (const imageSize of IMAGE_SIZES) {
      for (const orientation of ORIENTATIONS) {
        it(`${presetLabel} @ imageSize=${imageSize} orientation=${orientation}: every header fits, or overflow names the offending columns`, () => {
          const l = computeExportPdfLayout({
            fields: [...keys].map((k) => getExportField(k)!),
            itemTypeKind: itemType,
            includeImages: keys.includes('image'),
            imageSize,
            orientation,
            paperSize: 'letter',
            density: 'comfortable',
            wrapText: true,
            layout: 'table',
            catalogColumns: 2,
          });

          const offending: string[] = [];
          for (const col of l.columns) {
            const needed = headerWidth(col.label);
            const box = col.widthPt - REPORT_CELL_PADDING_PT * 2;
            if (needed > box) offending.push(col.label);
          }

          if (offending.length === 0) return;

          expect(
            l.overflow,
            `${presetLabel} @ ${imageSize}/${orientation}: ${offending.join(', ')} overflow their header box but layout.overflow is false`,
          ).toBe(true);
          const warningText = l.warnings.join(' | ');
          for (const label of offending) {
            expect(
              warningText,
              `${presetLabel} @ ${imageSize}/${orientation}: no warning names the offending column "${label}" (warnings: ${JSON.stringify(l.warnings)})`,
            ).toContain(label);
          }
        });
      }
    }
  }
});

/**
 * CRITICAL 2 (Task 8 review): `fitColumnWidths`' scale-down branch has no
 * concept of `wrap: false` identifier columns, so it shrinks ISBN exactly
 * like a prose column once minimums don't fit — reproduced by the reviewer
 * against the shipped engine's own widest-field-set (ISBN 63.24pt, box
 * 57.24pt) and 24-field/portrait/large (ISBN 27.64pt, box 21.64pt)
 * scenarios, both well under the 72.76pt a real 17-character hyphenated
 * ISBN needs. Brief section 11: "NEVER truncate ISBN."
 */
describe('computeExportPdfLayout — ISBN never squeezed below its worst-case value (Brief section 11)', () => {
  const worstCaseNeeded = valueWidth(WORST_CASE_ISBN_VALUE);

  function isbnBox(
    keys: readonly InventoryExportFieldKey[],
    imageSize: ExportImageSize,
    orientation: 'auto' | PdfOrientation,
  ): number {
    const l = computeExportPdfLayout({
      fields: keys.map((k) => getExportField(k)!),
      itemTypeKind: 'book',
      includeImages: keys.includes('image'),
      imageSize,
      orientation,
      paperSize: 'letter',
      density: 'comfortable',
      wrapText: true,
      layout: 'table',
      catalogColumns: 2,
    });
    const isbn = l.columns.find((c) => c.key === 'isbn');
    if (!isbn) throw new Error('isbn column missing from a books preset');
    return isbn.widthPt - REPORT_CELL_PADDING_PT * 2;
  }

  const IMAGE_SIZES: ExportImageSize[] = ['small', 'medium', 'large'];
  const ORIENTATIONS: Array<'auto' | PdfOrientation> = ['auto', 'portrait', 'landscape'];

  for (const imageSize of IMAGE_SIZES) {
    for (const orientation of ORIENTATIONS) {
      it(`Books default @ imageSize=${imageSize} orientation=${orientation}: isbn box holds the worst-case value`, () => {
        expect(
          isbnBox(BOOKS_DEFAULT, imageSize, orientation),
        ).toBeGreaterThanOrEqual(worstCaseNeeded);
      });
    }
  }

  it('widest field set: isbn box holds the worst-case value', () => {
    const keys: InventoryExportFieldKey[] = [
      ...BOOKS_DEFAULT,
      'barcode',
      'warehouse',
      'supplier',
      'charter',
    ];
    expect(isbnBox(keys, 'medium', 'auto')).toBeGreaterThanOrEqual(worstCaseNeeded);
  });

  it('24-field scenario (portrait, large image): isbn box holds the worst-case value', () => {
    const keys: InventoryExportFieldKey[] = [
      'image', 'name', 'isbn', 'sku', 'author', 'grade', 'quantity_on_hand', 'category',
      'rack', 'crate', 'primary_location', 'status', 'barcode', 'warehouse', 'supplier',
      'charter', 'item_type', 'tracking_type', 'reorder_point', 'reorder_quantity',
      'unit_cost', 'retail_price', 'inventory_value', 'created_at', 'updated_at',
    ];
    expect(isbnBox(keys, 'large', 'portrait')).toBeGreaterThanOrEqual(worstCaseNeeded);
  });
});

describe('computeExportPdfLayout — orientation', () => {
  it('picks portrait for a short, imageless field set', () => {
    expect(layoutFor(['name', 'isbn', 'sku']).orientation).toBe('portrait');
  });

  it('picks landscape for the 12-field Books default', () => {
    expect(layoutFor(BOOKS_DEFAULT).orientation).toBe('landscape');
  });

  it('honours an explicit choice over auto, and computes real geometry for it (not just the label)', () => {
    // Forcing portrait on the 12-field Books default is exactly the input
    // that can't fit (CRITICAL 1): asserting only `.orientation === 'portrait'`
    // and stopping there — as this test used to — discards the geometry the
    // call just computed and would pass even if that geometry silently
    // collided headers. Portrait's own page dimensions plus a real,
    // non-silent overflow report (never a bare 'orientation' echo) are the
    // actual contract an explicit choice has to honour.
    const portrait = layoutFor(BOOKS_DEFAULT, { orientation: 'portrait' });
    expect(portrait.orientation).toBe('portrait');
    expect(portrait.pageWidthPt).toBe(612);
    expect(portrait.pageHeightPt).toBe(792);
    expect(portrait.contentWidthPt).toBeLessThan(
      layoutFor(BOOKS_DEFAULT, { orientation: 'landscape' }).contentWidthPt,
    );
    expect(portrait.columns).toHaveLength(11);
    for (const col of portrait.columns) {
      expect(col.widthPt, `${col.key} got a non-positive width`).toBeGreaterThan(0);
    }
    // The 12-field Books default cannot fit portrait's content width (see
    // the dedicated overflow suite below) — an honest explicit choice
    // reports that rather than quietly returning as if it fit.
    expect(portrait.overflow).toBe(true);
    expect(portrait.warnings.length).toBeGreaterThan(0);

    const landscape = layoutFor(['name'], { orientation: 'landscape' });
    expect(landscape.orientation).toBe('landscape');
    expect(landscape.pageWidthPt).toBe(792);
    expect(landscape.pageHeightPt).toBe(612);
    expect(landscape.columns).toHaveLength(1);
    expect(landscape.columns[0]!.widthPt).toBeGreaterThan(0);
    expect(landscape.overflow).toBe(false);
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

  /**
   * CONTROLLER RIDER (Task 9 re-review of Task 8): `overflowRemedies` offers
   * "Legal paper" as a remedy (its own code comment above), but until now no
   * test actually drove a scenario down that branch — every existing overflow
   * test here uses `paperSize: 'letter'` throughout, or the 24-field/portrait
   * scenario immediately above, whose overflow is wide enough that even Legal
   * wouldn't clear it (`fieldsFitAt` for Legal would still find offending
   * keys, so the remedy is never offered and that branch stays unexercised).
   * The reviewer's own trial run found the real trigger: BOOKS_DEFAULT_FIELD_KEYS
   * minus its image field, plus barcode and warehouse — 13 fields, no image —
   * at orientation 'landscape' overflows Letter (13 columns squeeze several
   * labels below their own minimum) but fits cleanly once the SAME set is
   * measured against Legal's wider landscape content width. Both halves are
   * asserted so the branch is genuinely covered, not merely reached.
   */
  it('recommends Legal paper for a field set that overflows Letter landscape but fits Legal landscape', () => {
    const keys: InventoryExportFieldKey[] = [
      ...BOOKS_DEFAULT_FIELD_KEYS.filter((k) => k !== 'image'),
      'barcode',
      'warehouse',
    ];

    const letter = layoutFor(keys, { orientation: 'landscape', paperSize: 'letter' });
    expect(letter.overflow).toBe(true);
    expect(letter.warnings.some((w) => w.includes('Legal paper'))).toBe(true);

    const legal = layoutFor(keys, { orientation: 'landscape', paperSize: 'legal' });
    expect(legal.overflow).toBe(false);
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
