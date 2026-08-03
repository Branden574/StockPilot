import { describe, expect, it } from 'vitest';

import { fitColumnWidths, type FitColumn } from './column-fit';

/**
 * The allocator behind every StockPilot PDF table. The invariant that matters
 * is not "columns look about right" — it is that a narrow column can never be
 * squeezed below the width its content genuinely needs, because @react-pdf
 * silently overflows instead of erroring (the same failure mode that shipped
 * the owner's "ON HANDCATEGORY" header).
 */
describe('fitColumnWidths', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('splits by weight when no minimum binds', () => {
    const cols: FitColumn[] = [
      { key: 'a', width: 3 },
      { key: 'b', width: 1 },
    ];
    expect(fitColumnWidths(cols, 400)).toEqual([300, 100]);
  });

  it('treats a missing weight as 1', () => {
    expect(fitColumnWidths([{ key: 'a' }, { key: 'b' }], 200)).toEqual([100, 100]);
  });

  it('never lets a column fall below its minWidth — the header-collision guard', () => {
    // 'b' would get 100 * 0.5/10.5 = 4.8pt on weight alone. "ON HAND" cannot
    // render in 4.8pt, so the minimum wins and the wide column pays for it.
    const widths = fitColumnWidths(
      [
        { key: 'a', width: 10 },
        { key: 'b', width: 0.5, minWidth: 44 },
      ],
      100,
    );
    expect(widths[1]).toBe(44);
    expect(widths[0]).toBeCloseTo(56, 6);
    expect(sum(widths)).toBeCloseTo(100, 6);
  });

  it('honours maxWidth and redistributes the surplus to the others', () => {
    const widths = fitColumnWidths(
      [
        { key: 'a', width: 10, maxWidth: 60 },
        { key: 'b', width: 1 },
      ],
      200,
    );
    expect(widths[0]).toBe(60);
    expect(widths[1]).toBeCloseTo(140, 6);
  });

  it('scales minimums down proportionally rather than overflowing the page', () => {
    // Ten columns each demanding 80pt cannot fit in 400pt. Overflowing would
    // make @react-pdf clip silently; scaling keeps every column present and
    // proportionate, and the caller surfaces a warning.
    const cols: FitColumn[] = Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`,
      width: 1,
      minWidth: 80,
    }));
    const widths = fitColumnWidths(cols, 400);
    expect(sum(widths)).toBeCloseTo(400, 6);
    for (const w of widths) expect(w).toBeCloseTo(40, 6);
  });

  it('never returns a sum greater than the available width, for any mix', () => {
    const cols: FitColumn[] = [
      { key: 'name', width: 3, minWidth: 90 },
      { key: 'sku', width: 1.4, minWidth: 52 },
      { key: 'isbn', width: 1.6, minWidth: 66 },
      { key: 'qty', width: 0.9, minWidth: 44, maxWidth: 60 },
      { key: 'cat', width: 1.4, minWidth: 58 },
      { key: 'loc', width: 1.4, minWidth: 58 },
      { key: 'status', width: 1, minWidth: 46 },
    ];
    for (const available of [200, 320, 480, 704, 900]) {
      const widths = fitColumnWidths(cols, available);
      expect(widths).toHaveLength(cols.length);
      expect(sum(widths)).toBeLessThanOrEqual(available + 1e-6);
      for (const w of widths) expect(w).toBeGreaterThan(0);
    }
  });

  it('returns an empty array for no columns and zeroes for a zero-width page', () => {
    expect(fitColumnWidths([], 500)).toEqual([]);
    expect(fitColumnWidths([{ key: 'a' }, { key: 'b' }], 0)).toEqual([0, 0]);
  });
});
