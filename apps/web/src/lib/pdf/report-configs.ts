import type { ReportColumn } from './report-table';

/**
 * Static column/section shape for every `/api/reports/[slug]/pdf` report.
 *
 * WHY THIS EXISTS: `report-headers-fit.test.ts` needs the REAL production
 * column configs — the same objects the route renders — to catch the exact
 * class of defect Task 1's review found: a header that fits its box in
 * isolation but overflows once the shared allocator + the new 6pt gutter are
 * both applied to the actual report's column set. Extracting the (data-free)
 * shape lets the test import it directly instead of invoking the route
 * handler. The route below imports these same objects for `sections[].columns`
 * (and `imageColumn`/`title` where applicable) — this file is not a second
 * copy, it is the one definition both the route and the test share.
 *
 * Only the STATIC shape lives here: column key/label/align/width/minWidth/
 * maxWidth, per-section `title`, and `imageColumn`. Row data is always
 * request-scoped (org-specific query results) and stays in the route.
 */

export interface ReportPdfSectionConfig {
  /** Optional section title shown above the table (stock-movements only). */
  title?: string;
  /** Show the 22pt image column? Default false. */
  imageColumn?: boolean;
  /** Column definitions in left-to-right order. */
  columns: ReportColumn[];
}

/**
 * FIX-WAVE (post Task-1-review): four of the ten reports below carry columns
 * whose header did not fit its content box once fed through the real
 * allocator + the real header-width formula — either a regression Task 1's
 * new 6pt header gutter introduced, a defect that predates Task 1 entirely,
 * or a near-zero margin one label rename away from becoming one. Every
 * minWidth added below is derived, not eyeballed:
 *
 *   minWidth = ceil(headerWidth(LABEL) + 2*REPORT_CELL_PADDING_PT + 2pt safety)
 *
 * where headerWidth() is the exact formula report-table.tsx's header cell
 * renders with — Helvetica-Bold advance widths at REPORT_HEADER_FONT_SIZE_PT,
 * plus REPORT_HEADER_LETTER_SPACING_PT per character (uppercase, since
 * textTransform: 'uppercase' is applied before @react-pdf measures the
 * string). The 2pt is a fixed safety margin on top of the exact fit, per the
 * fix-wave brief. Each affected report's comment below states which columns
 * were fixed and why; full arithmetic (every column, every pass of the
 * convergence) is in .superpowers/sdd/task-1-report.md under "Fix wave".
 *
 * Adding a minWidth to one column always shrinks the surplus every
 * weight-based (no-minWidth) column shares — so each report below was
 * re-verified with the real allocator AFTER its fix, not just at the moment
 * the fix was written, and any column that fix knock-on effects squeezed
 * below the 2pt floor got its own minWidth too (iterated to a fixed point).
 * `report-headers-fit.test.ts` asserts, for all four reports: every column
 * still fits, every column keeps at least the 2pt margin, and the sum of
 * minWidths stays below the section's available width (the fitColumnWidths
 * scale-down branch never has to engage).
 */
export const REPORT_PDF_SECTIONS: Readonly<Record<string, readonly ReportPdfSectionConfig[]>> = {
  'inventory-valuation': [
    {
      imageColumn: true,
      columns: [
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'name', label: 'Name', width: 32 },
        { key: 'warehouse', label: 'Warehouse', width: 14 },
        { key: 'category', label: 'Category', width: 12 },
        { key: 'qty', label: 'On hand', align: 'right', width: 8 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 10 },
        { key: 'value', label: 'Value', align: 'right', width: 10 },
      ],
    },
  ],

  'stock-movements': [
    {
      title: 'By movement type',
      columns: [
        { key: 'type', label: 'Movement type', width: 30 },
        { key: 'count', label: 'Movements', align: 'right', width: 12 },
        { key: 'total', label: 'Total units (gross)', align: 'right', width: 14 },
      ],
    },
    {
      title: 'Top movers',
      imageColumn: true,
      columns: [
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'name', label: 'Name', width: 30 },
        { key: 'movements', label: 'Movements', align: 'right', width: 10 },
        { key: 'in', label: 'Units in', align: 'right', width: 10 },
        { key: 'out', label: 'Units out', align: 'right', width: 10 },
        { key: 'net', label: 'Net change', align: 'right', width: 10 },
      ],
    },
  ],

  // Fixed: `reorder_at`/`Reorder at` and `reorder_qty`/`Reorder qty` already
  // overflowed their header box before Task 1 touched anything (margins of
  // -0.91pt and -7.09pt against the OLD zero-padding header cell) and the
  // 6pt gutter made both worse (-6.91pt / -13.09pt). Found by the exhaustive
  // sweep Fix 2 requires, not named in the original review — see the
  // module doc comment above and the fix-wave report for the arithmetic.
  // `qty`/`On hand` and `unit`/`Unit cost` picked up the same collateral
  // near-zero-margin effect seen in dead-stock once the two real overflows
  // above lock in their minimums, so they get one too.
  'reorder-forecast': [
    {
      imageColumn: true,
      columns: [
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'name', label: 'Name', width: 28 },
        { key: 'warehouse', label: 'Warehouse', width: 14 },
        { key: 'qty', label: 'On hand', align: 'right', width: 8, minWidth: 49 },
        { key: 'reorder_at', label: 'Reorder at', align: 'right', width: 9, minWidth: 65 },
        { key: 'reorder_qty', label: 'Reorder qty', align: 'right', width: 9, minWidth: 72 },
        { key: 'deficit', label: 'Deficit', align: 'right', width: 8 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 9, minWidth: 55 },
        { key: 'est', label: 'Est. cost', align: 'right', width: 10 },
      ],
    },
  ],

  'supplier-scorecard': [
    {
      columns: [
        { key: 'supplier', label: 'Supplier', width: 22 },
        { key: 'pos', label: 'POs', align: 'right', width: 6 },
        { key: 'open_pos', label: 'Open POs', align: 'right', width: 8 },
        { key: 'open_value', label: 'Open value', align: 'right', width: 11 },
        { key: 'spend', label: 'Spend', align: 'right', width: 11 },
        { key: 'on_time', label: 'On-time', align: 'right', width: 8 },
        { key: 'lead', label: 'Avg lead', align: 'right', width: 8 },
        { key: 'fill', label: 'Fill rate', align: 'right', width: 8 },
        { key: 'last', label: 'Last received', align: 'right', width: 12 },
      ],
    },
  ],

  // Fixed: `class` (near-miss 0.57pt), `qty`/`On hand` (near-miss 1.45pt),
  // `unit`/`Unit cost` and `units_out`/`Units out` (near-miss 0.81pt each).
  // See the module doc comment above for the derivation arithmetic.
  'velocity-class': [
    {
      imageColumn: true,
      columns: [
        { key: 'class', label: 'Class', align: 'center', width: 6, minWidth: 38 },
        { key: 'sku', label: 'SKU', width: 12 },
        { key: 'name', label: 'Name', width: 26 },
        { key: 'warehouse', label: 'Warehouse', width: 12 },
        { key: 'category', label: 'Category', width: 12 },
        { key: 'qty', label: 'On hand', align: 'right', width: 8, minWidth: 49 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 9, minWidth: 55 },
        { key: 'units_out', label: 'Units out', align: 'right', width: 9, minWidth: 55 },
        { key: 'value_out', label: 'Value out', align: 'right', width: 10 },
        { key: 'last_out', label: 'Last out', align: 'right', width: 10 },
      ],
    },
  ],

  // Fixed: `stagnant`/`Stagnant` (Task 1 regression, 3.42pt deficit),
  // `age`/`Age (days)` and `carry`/`Carrying value` (pre-existing overflows,
  // predate Task 1), plus `qty`/`On hand` and `unit`/`Unit cost` (new
  // near-zero margin caused by redistributing surplus away from them once
  // the three fixes above lock in their minimums). See the module doc
  // comment above for the derivation arithmetic.
  'dead-stock': [
    {
      imageColumn: true,
      columns: [
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'name', label: 'Name', width: 26 },
        { key: 'warehouse', label: 'Warehouse', width: 12 },
        { key: 'category', label: 'Category', width: 12 },
        { key: 'qty', label: 'On hand', align: 'right', width: 8, minWidth: 49 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 9, minWidth: 55 },
        { key: 'carry', label: 'Carrying value', align: 'right', width: 11, minWidth: 86 },
        { key: 'age', label: 'Age (days)', align: 'right', width: 8, minWidth: 60 },
        { key: 'stagnant', label: 'Stagnant', align: 'right', width: 8, minWidth: 56 },
      ],
    },
  ],

  // Fixed: `value`/`Component value out` already overflowed its header box
  // before Task 1 touched anything (margin -8.49pt against the OLD
  // zero-padding header cell) and the 6pt gutter made it worse (-14.49pt).
  // Found by the exhaustive sweep Fix 2 requires, not named in the original
  // review — see the module doc comment above and the fix-wave report for
  // the arithmetic.
  'bundle-activity': [
    {
      columns: [
        { key: 'bundle', label: 'Bundle', width: 28 },
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'runs', label: 'Runs', align: 'right', width: 8 },
        { key: 'kits', label: 'Kits out', align: 'right', width: 9 },
        { key: 'value', label: 'Component value out', align: 'right', width: 14, minWidth: 117 },
        { key: 'top', label: 'Top warehouse', width: 14 },
        { key: 'last', label: 'Last run', align: 'right', width: 12 },
      ],
    },
  ],

  'bundle-shortages': [
    {
      imageColumn: true,
      columns: [
        { key: 'sku', label: 'SKU', width: 14 },
        { key: 'item', label: 'Item', width: 34 },
        { key: 'events', label: 'Shortage events', align: 'right', width: 14 },
        { key: 'short', label: 'Units short', align: 'right', width: 12 },
        { key: 'last', label: 'Last short at', align: 'right', width: 12 },
      ],
    },
  ],

  shrinkage: [
    {
      imageColumn: true,
      columns: [
        { key: 'when', label: 'When', width: 12 },
        { key: 'sku', label: 'SKU', width: 12 },
        { key: 'item', label: 'Item', width: 24 },
        { key: 'units', label: 'Units', align: 'right', width: 7 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 9 },
        { key: 'cost', label: 'Cost impact', align: 'right', width: 11 },
        { key: 'reason', label: 'Reason', width: 12 },
        { key: 'notes', label: 'Notes', width: 16 },
      ],
    },
  ],

  'item-cost-history': [
    {
      columns: [
        { key: 'supplier', label: 'Supplier', width: 28 },
        { key: 'date', label: 'Date', width: 14 },
        { key: 'unit', label: 'Unit cost', align: 'right', width: 14 },
        { key: 'source', label: 'Source', align: 'center', width: 10 },
      ],
    },
  ],
};
