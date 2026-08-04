import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import {
  BOOKS_DEFAULT_FIELD_KEYS,
  fieldHeading,
  getExportField,
  ITEMS_DEFAULT_FIELD_KEYS,
} from '../exports/field-registry';
import {
  fitColumnWidths,
  LETTER_LANDSCAPE_CONTENT_WIDTH_PT,
  REPORT_CELL_PADDING_PT,
  REPORT_IMAGE_COL_GAP_PT,
  REPORT_IMAGE_COL_WIDTH_PT,
} from './column-fit';
import { REPORT_HEADER_FONT_SIZE_PT, REPORT_HEADER_LETTER_SPACING_PT } from './report-table';

/**
 * Permanent regression net for the field registry's OWN default presets
 * (Task 4 review finding).
 *
 * WHY THIS EXISTS: `report-headers-fit.test.ts` covers the ten
 * `/api/reports/[slug]/pdf` configs, `export-pdf-headers-fit.test.ts` covers
 * the `/api/inventory/export` route's hand-picked `BOOKS_PDF_COLUMNS` /
 * `ITEMS_PDF_COLUMNS`. Neither one ever looks at `field-registry.ts`'s
 * `BOOKS_DEFAULT_FIELD_KEYS` / `ITEMS_DEFAULT_FIELD_KEYS` — the presets a
 * later task (Phase C) will feed straight into a PDF render once the builder
 * dialog is wired up. This is the THIRD permanent net, closing that gap the
 * same way the first two do: resolve each default key's `pdfWidth` /
 * `pdfMinWidth` / `label` from the REAL registry, feed them through the REAL
 * `fitColumnWidths` allocator and the REAL header-width formula, and assert
 * every header fits its content box.
 *
 * THE IMAGE COLUMN: `BOOKS_DEFAULT_FIELD_KEYS` opens with `image`
 * (`pdfWidth: 0`), which — per `field-registry.test.ts`'s own comment —
 * mirrors report-table.tsx's fixed 22pt image-column reserve
 * (`REPORT_IMAGE_COL_WIDTH_PT` + `REPORT_IMAGE_COL_GAP_PT` = 26, exactly
 * `image.pdfMinWidth`), not a normal text-header column. Every report section
 * that turns on `imageColumn` deducts that same 26pt from the available width
 * BEFORE calling `fitColumnWidths` and never puts an `image` entry in the
 * `columns` array at all (see `report-table-fit.test.ts`'s "still fits once
 * the 22pt image column is reserved" — `OWNER_COLUMNS` has no image key, the
 * reserve is a pure width deduction). This suite mirrors that exact
 * convention: `image` is excluded from the allocated/asserted column set and
 * its 26pt is deducted from the available width up front. Mathematically this
 * gives every OTHER column the identical width `fitColumnWidths` would produce
 * if `image` were left in as a real 0-weight/26pt-floor column (a 0-weight
 * column always locks at its floor on the very first pass regardless of its
 * neighbours), so this simplification does not change any other column's
 * number — it only avoids asserting header-text fit for a column that never
 * renders header text.
 *
 * FIX-WAVE (this review): running this exact sweep against the unmodified
 * registry (`quantity_on_hand.pdfMinWidth: 44`) reproduces the exact defect
 * Task 1's fix-wave already found and fixed in `BOOKS_PDF_COLUMNS` — "On
 * hand" overflows its own header box by -2.13pt — and in BOTH presets, not
 * just Books:
 *
 *   BOOKS_DEFAULT_FIELD_KEYS (12 fields, image's 26pt reserved):
 *     available = 704 - 26 = 678
 *     quantity_on_hand width = 44.00, box = 44.00 - 6 = 38.00
 *     needed = headerWidth('On hand') = 40.13
 *     margin = 38.00 - 40.13 = -2.13   OVERFLOW
 *
 *   ITEMS_DEFAULT_FIELD_KEYS (10 fields, no image key at all):
 *     available = 704
 *     quantity_on_hand width = 44.00, box = 38.00
 *     needed = 40.13
 *     margin = -2.13   OVERFLOW (identical number — a coincidence of both
 *     presets converging on the same allocated width, not a shared bug)
 *
 * Fixed by raising `quantity_on_hand.pdfMinWidth` to 49 in field-registry.ts
 * (the same 49pt floor `inventory-pdf-columns.ts` and `report-configs.ts`
 * already use for this exact label), which resolves both overflows to a
 * measured 2.87pt margin — see the locked-in margin test below.
 */

function headerWidth(label: string): number {
  const shown = label.toUpperCase();
  return (
    width(shown, 'Helvetica-Bold', REPORT_HEADER_FONT_SIZE_PT) +
    shown.length * REPORT_HEADER_LETTER_SPACING_PT
  );
}

interface PresetColumn {
  key: string;
  label: string;
  width: number;
  minWidth: number;
  maxWidth?: number;
}

/**
 * Resolve a default-preset key list into `fitColumnWidths` input, reading
 * `pdfWidth` / `pdfMinWidth` / `pdfMaxWidth` / the real heading straight off
 * the registry — never a hand-copied number. `image` is left out (see the
 * file-level comment): it is the one key in these presets that is a fixed
 * reserve, not a text-header column.
 */
function resolvePresetColumns(
  keys: readonly string[],
  itemType: 'book' | 'other',
): PresetColumn[] {
  return keys
    .filter((key) => key !== 'image')
    .map((key) => {
      const field = getExportField(key);
      if (!field) throw new Error(`${key} is in a default preset but not in the registry`);
      return {
        key,
        label: fieldHeading(field, { format: 'pdf', itemType }),
        width: field.pdfWidth,
        minWidth: field.pdfMinWidth,
        maxWidth: field.pdfMaxWidth,
      };
    });
}

const PRESETS = {
  'BOOKS_DEFAULT_FIELD_KEYS (books)': {
    keys: BOOKS_DEFAULT_FIELD_KEYS,
    itemType: 'book' as const,
    // BOOKS_DEFAULT_FIELD_KEYS opens with `image` — reserve its fixed 26pt
    // (REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT, exactly
    // image.pdfMinWidth) the same way an imageColumn:true report section does.
    imageReserved: true,
  },
  'ITEMS_DEFAULT_FIELD_KEYS (items)': {
    keys: ITEMS_DEFAULT_FIELD_KEYS,
    itemType: 'other' as const,
    // ITEMS_DEFAULT_FIELD_KEYS never includes `image` (Brief section 9: items
    // PDF images default OFF) — no reserve to deduct.
    imageReserved: false,
  },
} as const;

describe("every field registry default preset's header fits its content box", () => {
  for (const [label, { keys, itemType, imageReserved }] of Object.entries(PRESETS)) {
    it(`${label}: every header fits after the ${REPORT_CELL_PADDING_PT * 2}pt gutter`, () => {
      const columns = resolvePresetColumns(keys, itemType);
      const available =
        LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
        (imageReserved ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
      const widths = fitColumnWidths(columns, available);

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
      const columns = resolvePresetColumns(keys, itemType);
      const available =
        LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
        (imageReserved ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
      const totalMin = columns.reduce((a, c) => a + Math.max(0, c.minWidth ?? 0), 0);
      expect(totalMin).toBeLessThan(available);
    });
  }
});

describe('the fix-wave column keeps a real, measured margin in both presets', () => {
  // Locks in the exact derivation in the file-level comment above: a future
  // edit (a new field inserted into either default preset, a pdfWidth
  // reweight, a label rename) that erodes quantity_on_hand's margin back
  // toward zero is caught here even if it doesn't cross all the way into an
  // overflow.
  const SAFETY_MARGIN_PT = 2;

  it.each(Object.entries(PRESETS))(
    '%s: "On hand" keeps at least the 2pt safety margin the fix derived',
    (label, { keys, itemType, imageReserved }) => {
      const columns = resolvePresetColumns(keys, itemType);
      const available =
        LETTER_LANDSCAPE_CONTENT_WIDTH_PT -
        (imageReserved ? REPORT_IMAGE_COL_WIDTH_PT + REPORT_IMAGE_COL_GAP_PT : 0);
      const widths = fitColumnWidths(columns, available);
      const i = columns.findIndex((c) => c.key === 'quantity_on_hand');
      expect(i, `${label} has no quantity_on_hand column`).toBeGreaterThanOrEqual(0);
      const box = widths[i]! - REPORT_CELL_PADDING_PT * 2;
      const margin = box - headerWidth('On hand');
      expect(
        margin,
        `${label} → "On hand" margin dropped below the derived safety floor`,
      ).toBeGreaterThanOrEqual(SAFETY_MARGIN_PT - 1e-6);
    },
  );
});
