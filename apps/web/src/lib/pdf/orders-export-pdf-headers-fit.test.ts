import { describe, expect, it } from 'vitest';

import { EXPORTABLE_ORDER_STATUSES } from '@/lib/orders/export';

import { REPORT_BODY_FONT_SIZE_PT, REPORT_CELL_PADDING_PT } from './column-fit';
import { safeWidth } from './helvetica-metrics';
import {
  computeOrdersExportPdfColumns,
  ORDERS_PDF_CONTENT_WIDTH_PT,
} from './orders-export-pdf';

/**
 * Permanent regression net for the orders export PDF column geometry — the
 * sibling of export-pdf-headers-fit.test.ts (which closed the
 * "ON HANDCATEGORY" header-collision class for the inventory export) and
 * report-headers-fit.test.ts (the ten report configs).
 *
 * The review that approved the orders document verified its floors fit
 * Legal-landscape by hand: floors summed 888pt of the 920pt content width —
 * a real but THIN 32pt margin. Nothing pinned it, so a 15th column or a
 * wider header label could silently push past the page and engage
 * fitColumnWidths' proportional scale-down, reintroducing the collision
 * class. These pins measure the REAL production columns (the same
 * computeOrdersExportPdfColumns() the route renders) with the REAL Helvetica
 * AFM metrics — nothing is recomputed from the implementation's internals.
 *
 * Font-size literal: the document's table headings render at 8pt
 * Helvetica-Bold WITHOUT the uppercase+letterSpacing treatment (deliberate —
 * snake_case CSV labels are unbreakable tokens; see orders-export-pdf.tsx).
 * If the document ever changes heading size, this constant moves with it.
 */
const ORDERS_PDF_HEADER_FONT_SIZE_PT = 8;

function headerWidth(label: string): number {
  return safeWidth(label, 'Helvetica-Bold', ORDERS_PDF_HEADER_FONT_SIZE_PT);
}

function valueWidth(value: string): number {
  return safeWidth(value, 'Helvetica', REPORT_BODY_FONT_SIZE_PT);
}

/** The widest unbreakable fragment of the ISO timestamps the CSV emits —
 *  react-pdf line-breaks at the hyphens, so this is what must fit on one
 *  line inside a date column. */
const WORST_CASE_ISO_FRAGMENT = '01T00:00:00.000Z';

const COLUMNS = computeOrdersExportPdfColumns();

describe('orders export PDF column geometry', () => {
  it('every header fits its allocated content box', () => {
    for (const col of COLUMNS) {
      const box = col.widthPt - REPORT_CELL_PADDING_PT * 2;
      const needed = headerWidth(col.label);
      expect(
        needed <= box,
        `"${col.label}": header needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
      ).toBe(true);
    }
  });

  it('allocated widths exactly fill the Legal-landscape content width (the scale-down branch never engaged)', () => {
    const total = COLUMNS.reduce((a, c) => a + c.widthPt, 0);
    // fitColumnWidths distributes the full width when floors fit; a total
    // ABOVE the page means the proportional squeeze engaged and at least one
    // column is now narrower than its floor.
    expect(total).toBeLessThanOrEqual(ORDERS_PDF_CONTENT_WIDTH_PT + 0.01);
    expect(total).toBeGreaterThan(ORDERS_PDF_CONTENT_WIDTH_PT * 0.99);
  });

  it('the three timestamp columns are identical widths and fit the worst-case ISO fragment', () => {
    const dates = COLUMNS.filter((c) =>
      ['created_at', 'approved_at', 'completed_at'].includes(c.key),
    );
    expect(dates).toHaveLength(3);
    const [a, b, c] = dates;
    expect(a!.widthPt).toBe(b!.widthPt);
    expect(b!.widthPt).toBe(c!.widthPt);
    const box = a!.widthPt - REPORT_CELL_PADDING_PT * 2;
    expect(
      valueWidth(WORST_CASE_ISO_FRAGMENT) <= box,
      `"${WORST_CASE_ISO_FRAGMENT}" needs ${valueWidth(WORST_CASE_ISO_FRAGMENT).toFixed(2)}pt but the date box is ${box.toFixed(2)}pt`,
    ).toBe(true);
  });

  it('the status column fits every exportable status token on one line', () => {
    const status = COLUMNS.find((c) => c.key === 'status');
    expect(status).toBeDefined();
    const box = status!.widthPt - REPORT_CELL_PADDING_PT * 2;
    for (const token of EXPORTABLE_ORDER_STATUSES) {
      expect(
        valueWidth(token) <= box,
        `status "${token}" needs ${valueWidth(token).toFixed(2)}pt but the status box is ${box.toFixed(2)}pt`,
      ).toBe(true);
    }
  });
});
