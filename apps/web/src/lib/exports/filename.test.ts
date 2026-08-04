import { describe, expect, it } from 'vitest';

import { buildExportFilename, sanitizeFilenameSegment } from './filename';

const AUG_3 = new Date('2026-08-03T18:30:00.000Z');

describe('buildExportFilename', () => {
  it('names a filtered books PDF descriptively', () => {
    expect(
      buildExportFilename({ slug: 'books', scope: 'filtered', format: 'pdf', now: AUG_3 }),
    ).toBe('books-filtered-2026-08-03.pdf');
  });

  it('uses the preset name when there is one', () => {
    expect(
      buildExportFilename({
        slug: 'books',
        scope: 'all',
        format: 'xlsx',
        presetName: 'Books with covers',
        now: AUG_3,
      }),
    ).toBe('books-with-covers-2026-08-03.xlsx');
  });

  it('counts the records for a selected export', () => {
    expect(
      buildExportFilename({
        slug: 'inventory',
        scope: 'selected',
        format: 'pdf',
        count: 12,
        now: AUG_3,
      }),
    ).toBe('inventory-selected-12-items-2026-08-03.pdf');
  });

  it('singularizes one selected item', () => {
    expect(
      buildExportFilename({
        slug: 'inventory',
        scope: 'selected',
        format: 'csv',
        count: 1,
        now: AUG_3,
      }),
    ).toBe('inventory-selected-1-item-2026-08-03.csv');
  });

  it('falls back to the scope when a selected export has no count', () => {
    expect(
      buildExportFilename({ slug: 'books', scope: 'selected', format: 'csv', now: AUG_3 }),
    ).toBe('books-selected-2026-08-03.csv');
  });

  it('produces the brief\'s ISBN-list example', () => {
    expect(
      buildExportFilename({
        slug: 'books',
        scope: 'all',
        format: 'csv',
        presetName: 'Books ISBN list',
        now: AUG_3,
      }),
    ).toBe('books-isbn-list-2026-08-03.csv');
  });

  // ADDITIVE (not in the brief): Task 13 will call buildExportFilename with a
  // dialog state where a preset AND a selected-row count can both be set at
  // once (a user can pick a preset, then check individual rows). The brief
  // never exercises that combination, so the precedence — preset wins — is
  // otherwise a live behaviour nothing pins to a literal. Genuinely
  // discriminating: swapping the branch order in buildExportFilename (count
  // before preset) flips this from 'books-with-covers-...' to
  // 'books-selected-3-items-...'.
  it('prefers the preset name over the selected count when both are given', () => {
    expect(
      buildExportFilename({
        slug: 'books',
        scope: 'selected',
        format: 'csv',
        presetName: 'Books with covers',
        count: 3,
        now: AUG_3,
      }),
    ).toBe('books-with-covers-2026-08-03.csv');
  });

  // ADDITIVE (not in the brief): count: 0 is a real value a caller could pass
  // (e.g. a selection that resolved to zero rows before the request was
  // rejected upstream) and is distinct from "no count" (undefined) at the
  // type level, but `count > 0` in the implementation routes it down the
  // same fallback path as undefined. Pins that 0 does not survive into the
  // filename as "0-items".
  it('falls back to the scope for a selected export with a zero count', () => {
    expect(
      buildExportFilename({
        slug: 'inventory',
        scope: 'selected',
        format: 'csv',
        count: 0,
        now: AUG_3,
      }),
    ).toBe('inventory-selected-2026-08-03.csv');
  });
});

describe('sanitizeFilenameSegment', () => {
  it('strips path separators, quotes and control characters', () => {
    expect(sanitizeFilenameSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilenameSegment('my "preset"')).toBe('my-preset');
    expect(sanitizeFilenameSegment('a\r\nContent-Disposition: x')).toBe(
      'a-content-disposition-x',
    );
  });

  it('collapses runs and trims dashes', () => {
    expect(sanitizeFilenameSegment('  Books   with  covers  ')).toBe('books-with-covers');
    expect(sanitizeFilenameSegment('---')).toBe('');
  });

  it('caps the length so a hostile preset name cannot blow up the header', () => {
    expect(sanitizeFilenameSegment('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it('drops non-ASCII rather than emitting bytes a Content-Disposition cannot carry', () => {
    expect(sanitizeFilenameSegment('libros españoles 2026')).toBe('libros-espa-oles-2026');
  });
});
