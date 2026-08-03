import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import { fitColumnWidths, LETTER_LANDSCAPE_CONTENT_WIDTH_PT, REPORT_CELL_PADDING_PT } from './column-fit';
import { BOOKS_PDF_COLUMNS, ITEMS_PDF_COLUMNS } from './inventory-pdf-columns';
import {
  REPORT_BODY_FONT_SIZE_PT,
  REPORT_HEADER_FONT_SIZE_PT,
  REPORT_HEADER_LETTER_SPACING_PT,
} from './report-table';

/**
 * Permanent regression net for the /api/inventory/export PDF column sets
 * (Task 1 re-review rider).
 *
 * WHY THIS EXISTS: `route.tsx`'s hand-picked PDF column subset is the
 * HISTORICAL ORIGIN of the header-collision defect ("ON HANDCATEGORY") that
 * `report-headers-fit.test.ts` now guards permanently for the ten
 * `/api/reports/[slug]/pdf` configs in `report-configs.ts` — but that file
 * never covered the export route, because its columns lived inline in
 * `route.tsx` until Task 2 extracted them to `inventory-pdf-columns.ts`. Task
 * 2 also adds a brand-new ISBN column to the Books set, which is exactly the
 * situation that reintroduces a collision if the new column's minWidth is
 * wrong. This suite closes that gap the same way `report-headers-fit.test.ts`
 * closes it for the report routes: feed the REAL production
 * `BOOKS_PDF_COLUMNS` / `ITEMS_PDF_COLUMNS` (the same objects `route.tsx`
 * imports) through the REAL allocator (`fitColumnWidths`) and the REAL
 * header-cell formula (Helvetica-Bold advance widths at
 * REPORT_HEADER_FONT_SIZE_PT + REPORT_HEADER_LETTER_SPACING_PT per
 * character, uppercase — @react-pdf applies textTransform before measuring).
 *
 * Neither export section ever sets `imageColumn`, so the available width is
 * the full LETTER_LANDSCAPE_CONTENT_WIDTH_PT with no image-column deduction.
 *
 * FIX-WAVE: running this exhaustive sweep against the real BOOKS_PDF_COLUMNS
 * (10 columns — less surplus per column than the 7-column set the brief's
 * `minWidth: 44` on `quantity_on_hand` was eyeballed against) found "On hand"
 * overflowing its own header box by -1.82pt. Derived exactly as Task 1's
 * fix-wave did:
 *   minWidth = ceil(headerWidth('On hand') + 2*REPORT_CELL_PADDING_PT + 2)
 *            = ceil(40.13 + 6 + 2) = ceil(48.13) = 49
 * — the same 49pt floor report-configs.ts already uses for this exact label
 * in dead-stock/reorder-forecast/velocity-class. See inventory-pdf-columns.ts
 * for the change. ITEMS_PDF_COLUMNS needed no fix: its `quantity_on_hand`
 * keeps `minWidth: 44` and still clears its header with a 14.21pt margin,
 * because a 7-column row leaves more surplus per column than the 10-column
 * Books row.
 */

function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

/**
 * Width of a rendered BODY cell value — plain Helvetica at
 * REPORT_BODY_FONT_SIZE_PT, no uppercase transform and no letterSpacing
 * (reportStyles.cell carries neither, unlike reportStyles.headerCell).
 */
function valueWidth(value: string): number {
  return width(value, 'Helvetica', REPORT_BODY_FONT_SIZE_PT);
}

/**
 * The worst-case ISBN value the isbn column must never truncate or wrap.
 *
 * A plain 13-digit ISBN-13 ("9781234567897") measures 61.44pt at
 * REPORT_BODY_FONT_SIZE_PT — but `inventory_items.barcode` (which doubles as
 * the book ISBN, inventory-export.ts) has NO digit-only guard anywhere a
 * human can type it: the Zod schema is `z.string().max(128).trim()` with no
 * regex (packages/core/src/schemas/inventory.ts), and item-form.tsx's ISBN
 * input registers straight onto it with no onChange stripping — only the
 * *automated* paths (barcode scanner, Google Books lookup, bulk book import)
 * normalize hyphens out via normalizeIsbn()/isbnVariants(). A person typing
 * the ISBN exactly as printed on a book's back cover — "978-1-234-56789-7",
 * the standard 5-group EAN/ISBN-13 hyphenation — saves verbatim. That is 13
 * digits + 4 hyphens = 17 characters, and is the real worst case, not the
 * unhyphenated 13-digit string.
 */
const WORST_CASE_ISBN_VALUE = '978-1-234-56789-7';

const EXPORT_PDF_COLUMN_SETS = {
  'books (BOOKS_PDF_COLUMNS)': BOOKS_PDF_COLUMNS,
  'non-books (ITEMS_PDF_COLUMNS)': ITEMS_PDF_COLUMNS,
} as const;

describe('every /api/inventory/export PDF column header fits its content box', () => {
  for (const [label, columns] of Object.entries(EXPORT_PDF_COLUMN_SETS)) {
    it(`${label}: every header fits after the ${REPORT_CELL_PADDING_PT * 2}pt gutter`, () => {
      const widths = fitColumnWidths(columns, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);
      columns.forEach((col, i) => {
        const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
        const needed = headerWidth(col.label);
        expect(
          needed <= box,
          `${label} → "${col.label}": header needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
        ).toBe(true);
      });
    });

    it(`${label}: minimums alone fit the page (the fitColumnWidths scale-down branch never engages)`, () => {
      const totalMin = columns.reduce((a, c) => a + Math.max(0, c.minWidth ?? 0), 0);
      expect(totalMin).toBeLessThan(LETTER_LANDSCAPE_CONTENT_WIDTH_PT);
    });

    it(`${label}: no wrap:false column (SKU/ISBN) is ever squeezed below its declared minWidth`, () => {
      const widths = fitColumnWidths(columns, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);
      columns.forEach((col, i) => {
        if (col.wrap === false) {
          expect(widths[i]!, `${label} → "${col.label}" fell below its minWidth`).toBeGreaterThanOrEqual(
            col.minWidth ?? 0,
          );
        }
      });
    });
  }
});

describe('the fix-wave column keeps a real, measured margin', () => {
  // Locks in the exact derivation above: re-asserting the measured margin
  // (not just boolean fit) catches a future edit — a new column inserted
  // into BOOKS_PDF_COLUMNS, a label rename, a width reweight — that erodes
  // "On hand"'s margin back toward zero without anyone re-running the sweep.
  const SAFETY_MARGIN_PT = 2;

  it('books: "On hand" keeps at least the 2pt safety margin the fix derived', () => {
    const widths = fitColumnWidths(BOOKS_PDF_COLUMNS, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);
    const i = BOOKS_PDF_COLUMNS.findIndex((c) => c.key === 'quantity_on_hand');
    const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
    const margin = box - headerWidth('On hand');
    expect(margin).toBeGreaterThanOrEqual(SAFETY_MARGIN_PT - 1e-6);
  });
});

describe('the isbn column holds its own worst-case VALUE, not just its header', () => {
  // BOOKS_PDF_COLUMNS is `wrap: false`, so a value wider than the content box
  // truncates or wraps into a garbled second line instead of shrinking — the
  // minWidth floor has to be sized against the widest VALUE the column can
  // ever actually render, not just the 4-letter header "ISBN".
  it('books: isbn column\'s content box fits the worst-case ISBN value at body font size', () => {
    const widths = fitColumnWidths(BOOKS_PDF_COLUMNS, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);
    const i = BOOKS_PDF_COLUMNS.findIndex((c) => c.key === 'isbn');
    const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
    const needed = valueWidth(WORST_CASE_ISBN_VALUE);
    expect(
      needed <= box,
      `isbn column: worst-case value "${WORST_CASE_ISBN_VALUE}" needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
    ).toBe(true);
  });
});
