/**
 * Tests for the cycle-count PDF's DISCLOSED render cap (finding: the route
 * stopped clamping at 1000 lines, so react-pdf would render an unbounded
 * line set — new OOM/timeout risk). Repo rule: silent caps are bugs,
 * disclosed caps are acceptable — so over the cap the sheet must carry a
 * first-page banner naming exactly what was cut; at or under the cap the
 * sheet renders in full with NO banner.
 */

import { describe, expect, it } from 'vitest';

import { PDF_MAX_LINES, capCountSheetLines } from './count-sheet-cap';

describe('capCountSheetLines', () => {
  it('under the cap → full line set, no banner (sheet unchanged)', () => {
    const lines = ['a', 'b', 'c'];

    const res = capCountSheetLines(lines);

    expect(res.lines).toEqual(['a', 'b', 'c']);
    expect(res.banner).toBeNull();
  });

  it('EXACTLY the cap → full sheet, still no banner (≤ 10000 is untouched)', () => {
    const lines = Array.from({ length: PDF_MAX_LINES }, (_, i) => i);

    const res = capCountSheetLines(lines);

    expect(res.lines).toHaveLength(PDF_MAX_LINES);
    expect(res.banner).toBeNull();
  });

  it('over the cap → first PDF_MAX_LINES lines + the disclosure banner', () => {
    const lines = Array.from({ length: PDF_MAX_LINES + 2345 }, (_, i) => i);

    const res = capCountSheetLines(lines);

    // The rendered prefix is the FIRST max lines of the (pre-sorted) input.
    expect(res.lines).toHaveLength(PDF_MAX_LINES);
    expect(res.lines[0]).toBe(0);
    expect(res.lines[PDF_MAX_LINES - 1]).toBe(PDF_MAX_LINES - 1);
    // Exact disclosure copy, numbers formatted with thousands separators.
    expect(res.banner).toBe(
      'Count sheet shows the first 10,000 of 12,345 lines — start warehouse-scoped counts for full printed coverage.',
    );
  });

  it('keeps the input order (cap must run AFTER the PDF sort, taking the sheet-first prefix)', () => {
    const lines = ['z-biggest-variance', 'm-mid', 'a-smallest'];

    const res = capCountSheetLines(lines, 2);

    expect(res.lines).toEqual(['z-biggest-variance', 'm-mid']);
    expect(res.banner).toBe(
      'Count sheet shows the first 2 of 3 lines — start warehouse-scoped counts for full printed coverage.',
    );
  });
});
