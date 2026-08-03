import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
import { REPORT_PDF_SECTIONS } from './report-configs';
import { REPORT_HEADER_FONT_SIZE_PT, REPORT_HEADER_LETTER_SPACING_PT } from './report-table';

/**
 * Permanent regression net for every LIVE `/api/reports/[slug]/pdf` report.
 *
 * WHY THIS EXISTS: `report-table-fit.test.ts` proves the allocator's geometric
 * invariants against a hand-picked example column set. It never actually
 * looks at what the ten real report slugs configure. The Task 1 review fed
 * the real production configs (from `report-configs.ts`, the same object the
 * route imports) through the real allocator + the real header-width formula
 * and found real defects — some named by the review, more found once this
 * suite's own "check every slug" methodology was run against the rest of the
 * report set:
 *
 *   - dead-stock's `Stagnant` header FIT before Task 1's 6pt header gutter
 *     and WRAPS after it (a regression this branch would have shipped).
 *   - dead-stock's `Age (days)` and `Carrying value`, reorder-forecast's
 *     `Reorder at` and `Reorder qty`, and bundle-activity's `Component value
 *     out` headers already overflowed their content box before Task 1
 *     touched anything (pre-existing defects, unrelated to the gutter
 *     change, found by running this exact suite against the unmodified
 *     configs).
 *   - velocity-class's `Class`, `Unit cost`, `Units out`, and `On hand`
 *     headers still fit after the gutter, but with 0.57-1.45pt of margin —
 *     effectively zero, one label rename away from wrapping.
 *
 * All of these were invisible to every other suite: the columns are
 * correct, the rows render, nothing throws. The only assertion that catches
 * this class of bug is exactly this one — for every column, in every real
 * report section, the label must fit inside the box the allocator gives it.
 * This suite makes that check permanent so any future edit to a report's
 * column set (`report-configs.ts`) or to the shared table geometry
 * (`column-fit.ts` / `report-table.tsx`) is caught here, in CI, instead of
 * being hand-verified once by a reviewer and never checked again.
 */

// reportStyles.headerCell renders uppercase with letterSpacing, and @react-pdf
// applies textTransform BEFORE measuring — so the header box has to fit the
// UPPERCASE label, not the label as authored.
function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

describe('every live report header fits its content box', () => {
  for (const [slug, sections] of Object.entries(REPORT_PDF_SECTIONS)) {
    sections.forEach((section, sectionIdx) => {
      const label = sections.length > 1 ? `${slug} § ${section.title ?? sectionIdx}` : slug;

      it(`${label}: every header fits after the ${REPORT_CELL_PADDING_PT * 2}pt gutter`, () => {
        const available =
          LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
          (section.imageColumn ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
        const widths = fitColumnWidths(section.columns, available);

        section.columns.forEach((col, i) => {
          const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
          const needed = headerWidth(col.label);
          expect(
            needed <= box,
            `${label} → "${col.label}": header needs ${needed.toFixed(2)}pt but its content box is ${box.toFixed(2)}pt`,
          ).toBe(true);
        });
      });
    });
  }
});

describe('the four reports the fix-wave touched keep a real, measured margin', () => {
  // dead-stock, velocity-class, reorder-forecast, and bundle-activity each
  // carried at least one column whose header genuinely overflowed, or fit
  // with essentially zero margin, once Task 1's gutter was applied to the
  // real config (see report-configs.ts's per-report comments for the
  // arithmetic). Re-asserting the exact margins here (not just boolean fit)
  // locks in the fix-wave's derivation so a future edit that erodes the
  // margin back toward zero is caught before it becomes another silent
  // near-miss. Every column that received a minWidth from this fix-wave is
  // checked, not just the specific column that originally failed — adding a
  // minWidth to one column reduces the surplus every weight-based column
  // shares, and that redistribution is exactly what turned two previously
  // fine dead-stock/reorder-forecast columns into new near-misses.
  const SAFETY_MARGIN_PT = 2;
  const FIXED_SLUGS = ['dead-stock', 'velocity-class', 'reorder-forecast', 'bundle-activity'] as const;

  it.each(FIXED_SLUGS)('%s: every column keeps at least the 2pt safety margin the fix derived', (slug) => {
    const section = REPORT_PDF_SECTIONS[slug]![0]!;
    const available =
      LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
      (section.imageColumn ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
    const widths = fitColumnWidths(section.columns, available);
    section.columns.forEach((col, i) => {
      const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
      const margin = box - headerWidth(col.label);
      expect(margin, `${slug} → "${col.label}" margin dropped below the derived safety floor`).toBeGreaterThanOrEqual(
        SAFETY_MARGIN_PT - 1e-6,
      );
    });
  });

  it.each(FIXED_SLUGS)('%s: the scale-down branch never engages — minimums alone fit the page', (slug) => {
    const section = REPORT_PDF_SECTIONS[slug]![0]!;
    const available =
      LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
      (section.imageColumn ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
    const totalMin = section.columns.reduce((a, c) => a + Math.max(0, c.minWidth ?? 0), 0);
    expect(totalMin).toBeLessThan(available);
  });
});
