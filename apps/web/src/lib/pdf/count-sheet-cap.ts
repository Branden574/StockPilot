/**
 * Disclosed render cap for the cycle-count PDF.
 *
 * The count-sheet route no longer clamps its line fetch at 1000 rows, so a
 * big-warehouse count can push tens of thousands of lines into
 * @react-pdf/renderer — which builds the whole document in memory and will
 * OOM / hit the serverless time budget well before 50k rows. Rendering must
 * therefore be bounded, but a SILENT bound is exactly the bug class this
 * program keeps killing (repo rule: silent caps are bugs; disclosed caps are
 * acceptable). So: render at most PDF_MAX_LINES lines and, when the count is
 * larger, disclose the truncation with a prominent first-page banner.
 *
 * Kept as a pure helper (no react-pdf imports) so the cap + banner decision
 * is unit-testable without rendering a PDF.
 */

/** Hard ceiling on lines rendered into one cycle-count PDF. */
export const PDF_MAX_LINES = 10_000;

/**
 * Caps `lines` at `max` and returns the banner copy disclosing the cut, or
 * null when everything fits (≤ max renders the full sheet, no banner).
 * Call AFTER the PDF's own sort so "the first N" are the sheet's first N
 * (SKU order for count sheets, biggest variances first for variance
 * reports), not an arbitrary prefix.
 */
export function capCountSheetLines<T>(
  lines: readonly T[],
  max: number = PDF_MAX_LINES,
): { lines: readonly T[]; banner: string | null } {
  if (lines.length <= max) return { lines, banner: null };
  const fmt = new Intl.NumberFormat('en-US');
  return {
    lines: lines.slice(0, max),
    banner:
      `Count sheet shows the first ${fmt.format(max)} of ${fmt.format(lines.length)} lines` +
      ' — start warehouse-scoped counts for full printed coverage.',
  };
}
