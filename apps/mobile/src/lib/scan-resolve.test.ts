import { describe, expect, it } from 'vitest';

import { resolveScanMatches, sanitizeScanCode } from './scan-resolve';

interface Row {
  id: string;
  barcode: string | null;
  sku: string;
  charterId: string | null;
}

const ROW_A: Row = { id: 'item-a', barcode: null, sku: 'SKU-1', charterId: 'charter-a' };
const ROW_B: Row = { id: 'item-b', barcode: null, sku: 'SKU-1', charterId: 'charter-b' };

describe('resolveScanMatches', () => {
  it('returns not_found for an empty result set', () => {
    expect(resolveScanMatches([], 'SKU-1')).toEqual({ kind: 'not_found' });
  });

  it('resolves a single row directly — the common, unambiguous case', () => {
    expect(resolveScanMatches([ROW_A], 'SKU-1')).toEqual({ kind: 'single', match: ROW_A });
  });

  /**
   * The core Model B bug: the same SKU legitimately exists as two placement
   * rows (different charters/racks). Scanning that SKU must surface BOTH so
   * the caller can put up a picker — never silently pick an arbitrary one.
   */
  it('two same-sku placements → the multiple branch with both rows, none dropped', () => {
    const resolution = resolveScanMatches([ROW_A, ROW_B], 'SKU-1');
    expect(resolution.kind).toBe('multiple');
    if (resolution.kind === 'multiple') {
      expect(resolution.matches).toHaveLength(2);
      expect(resolution.matches).toEqual([ROW_A, ROW_B]);
    }
  });

  it('an exact barcode match is unambiguous and wins over a same-code sku-only row', () => {
    const barcodeRow: Row = { id: 'item-barcode', barcode: 'BC123', sku: 'SKU-9', charterId: null };
    const skuCollisionRow: Row = { id: 'item-sku', barcode: null, sku: 'BC123', charterId: null };
    const resolution = resolveScanMatches([barcodeRow, skuCollisionRow], 'BC123');
    expect(resolution).toEqual({ kind: 'single', match: barcodeRow });
  });

  it('multiple exact barcode matches still surface a picker (rare, but never guess)', () => {
    const dup1: Row = { id: 'item-1', barcode: 'DUPE', sku: 'SKU-A', charterId: 'charter-a' };
    const dup2: Row = { id: 'item-2', barcode: 'DUPE', sku: 'SKU-B', charterId: 'charter-b' };
    const resolution = resolveScanMatches([dup1, dup2], 'DUPE');
    expect(resolution.kind).toBe('multiple');
  });
});

describe('sanitizeScanCode', () => {
  /**
   * A scanned value is interpolated directly into a PostgREST
   * `.or('barcode.eq.X,sku.eq.X')` filter string. Left unsanitized, a `%`,
   * `,`, `(`, or `)` in the scanned code would be parsed as PostgREST filter
   * syntax (an extra clause, a wildcard, a grouping) instead of a literal
   * character to match — mirrors the web lookup route's sanitization
   * (apps/web/src/app/api/v1/items/lookup/route.ts).
   */
  it('strips %, comma, and parens together from a single scanned code', () => {
    expect(sanitizeScanCode('SKU%1,(2)')).toBe('SKU12');
  });

  it('strips % from a scanned code', () => {
    expect(sanitizeScanCode('SKU%1')).toBe('SKU1');
  });

  it('strips a comma that would inject an extra .or() clause', () => {
    expect(sanitizeScanCode('SKU-1,sku.eq.OTHER')).toBe('SKU-1sku.eq.OTHER');
  });

  it('strips parentheses that would break PostgREST grouping', () => {
    expect(sanitizeScanCode('SKU(1)')).toBe('SKU1');
  });

  it('leaves an ordinary alphanumeric barcode/SKU untouched', () => {
    expect(sanitizeScanCode('SKU-1234-ABC')).toBe('SKU-1234-ABC');
  });
});
