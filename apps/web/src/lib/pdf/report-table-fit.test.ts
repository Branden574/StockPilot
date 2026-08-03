import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
import { REPORT_HEADER_FONT_SIZE_PT, REPORT_HEADER_LETTER_SPACING_PT } from './report-table';
import type { ReportColumn } from './report-table';

/**
 * Geometric invariants for the shared report table.
 *
 * WHY THIS EXISTS: the owner's Books PDF printed "ON HANDCATEGORY" — two
 * header labels touching with no gap. Both strings were present and correct,
 * so a rendered-text assertion would have passed. The defect was purely
 * geometric, and @react-pdf overflows silently, so nothing downstream
 * complained. The only assertion that catches this class of bug is the
 * invariant itself:
 *
 *   for every column, the uppercase header label must fit inside the content
 *   box its width buys once BOTH cells' horizontal padding is reserved
 *
 * Brief section 3.1 names this exact column combination as the test case.
 */

// reportStyles.headerCell renders uppercase with letterSpacing, and @react-pdf
// applies textTransform BEFORE measuring — so "ON HAND", not "On hand", is
// what has to fit.
function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

/** The exact combination Brief section 3.1 requires to stay separated. */
const OWNER_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52 },
  { key: 'isbn', label: 'ISBN', width: 1.6, minWidth: 66 },
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 44 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];

describe('report-table column fit — Name | SKU | ISBN | On Hand | Category | Location | Status', () => {
  const widths = fitColumnWidths(OWNER_COLUMNS, LETTER_LANDSCAPE_CONTENT_WIDTH_PT);

  it('fits inside the landscape LETTER row', () => {
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(LETTER_LANDSCAPE_CONTENT_WIDTH_PT + 1e-6);
  });

  it('gives every header label its own content box with room to spare', () => {
    OWNER_COLUMNS.forEach((col, i) => {
      const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
      const needed = headerWidth(col.label);
      expect(
        needed <= box,
        `${col.label}: header needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
      ).toBe(true);
    });
  });

  it('leaves a real gutter between ON HAND and CATEGORY — the exact reported collision', () => {
    const onHand = OWNER_COLUMNS.findIndex((c) => c.key === 'quantity_on_hand');
    const category = onHand + 1;
    // ON HAND is right-aligned and CATEGORY left-aligned, so the worst case is
    // ON HAND's text hard against its right padding and CATEGORY's hard against
    // its left padding. The gutter between the glyphs is then exactly the two
    // paddings, and it must be a visible gap, not zero (which is what shipped).
    const gutter = REPORT_CELL_PADDING_PT * 2;
    expect(gutter).toBeGreaterThanOrEqual(6);
    // And each label still fits its own box, so neither can bleed into the gap.
    expect(headerWidth('On hand')).toBeLessThanOrEqual(widths[onHand]! - REPORT_CELL_PADDING_PT * 2);
    expect(headerWidth('Category')).toBeLessThanOrEqual(
      widths[category]! - REPORT_CELL_PADDING_PT * 2,
    );
  });

  it('keeps the narrow numeric column at its readable minimum instead of shrinking it', () => {
    const onHand = OWNER_COLUMNS.findIndex((c) => c.key === 'quantity_on_hand');
    expect(widths[onHand]!).toBeGreaterThanOrEqual(44);
  });

  it('still fits once the 22pt image column is reserved', () => {
    const available =
      LETTER_LANDSCAPE_CONTENT_WIDTH_PT - REPORT_IMAGE_COL_WIDTH_PT - REPORT_IMAGE_COL_GAP_PT;
    const withImage = fitColumnWidths(OWNER_COLUMNS, available);
    OWNER_COLUMNS.forEach((col, i) => {
      const box = withImage[i]! - REPORT_CELL_PADDING_PT * 2;
      expect(headerWidth(col.label) <= box, `${col.label} collides once images are on`).toBe(true);
    });
  });

  it('does not regress the pre-existing inventory column set', () => {
    // The seven live report sections pass columns with no minWidth at all.
    // Those must keep their exact proportional split.
    const legacy: ReportColumn[] = [
      { key: 'name', label: 'Name', width: 3 },
      { key: 'sku', label: 'SKU', width: 1.4 },
      { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9 },
      { key: 'category', label: 'Category', width: 1.4 },
    ];
    const legacyWidths = fitColumnWidths(legacy, 670);
    const totalWeight = 3 + 1.4 + 0.9 + 1.4;
    expect(legacyWidths[0]!).toBeCloseTo((3 / totalWeight) * 670, 6);
    expect(legacyWidths[2]!).toBeCloseTo((0.9 / totalWeight) * 670, 6);
  });
});
