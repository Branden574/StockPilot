import { describe, expect, it } from 'vitest';

import { getCrateColor } from './crate-colors';

import {
  formatCrateLabel,
  formatCrateLocationName,
  formatGrade,
  readBookStorage,
} from './book-storage';

describe('getCrateColor', () => {
  it('returns the entry for a known slug', () => {
    expect(getCrateColor('red')?.label).toBe('Red');
    expect(getCrateColor('blue')?.hex).toBe('#3b82f6');
  });
  it('returns null for unknown or missing input', () => {
    expect(getCrateColor(null)).toBeNull();
    expect(getCrateColor(undefined)).toBeNull();
    expect(getCrateColor('')).toBeNull();
    expect(getCrateColor('mauve')).toBeNull();
  });
});

describe('formatGrade', () => {
  it('expands K to Kindergarten', () => {
    expect(formatGrade('K')).toBe('Kindergarten');
  });
  it('keeps Pre-K, College, Adult as-is', () => {
    expect(formatGrade('Pre-K')).toBe('Pre-K');
    expect(formatGrade('College')).toBe('College');
    expect(formatGrade('Adult')).toBe('Adult');
  });
  it('formats numeric grades as Grade N', () => {
    expect(formatGrade('1')).toBe('Grade 1');
    expect(formatGrade('12')).toBe('Grade 12');
  });
  it('passes through unknown slugs unchanged', () => {
    expect(formatGrade('Honors')).toBe('Honors');
  });
  it('returns null for nullish input', () => {
    expect(formatGrade(null)).toBeNull();
    expect(formatGrade(undefined)).toBeNull();
  });
});

describe('readBookStorage', () => {
  it('returns all-nulls and null labels for empty custom_fields', () => {
    const info = readBookStorage({});
    expect(info.rackNumber).toBeNull();
    expect(info.rackRow).toBeNull();
    expect(info.crateColor).toBeNull();
    expect(info.crateNumber).toBeNull();
    expect(info.grade).toBeNull();
    expect(info.rackLabel).toBeNull();
    expect(info.crateLabel).toBeNull();
  });

  it('handles null/undefined custom_fields without throwing', () => {
    expect(() => readBookStorage(null)).not.toThrow();
    expect(() => readBookStorage(undefined)).not.toThrow();
  });

  it('joins rack number + row into rackLabel', () => {
    expect(
      readBookStorage({ book_rack_number: '38', book_rack_row: 'A' }).rackLabel,
    ).toBe('38-A');
  });

  it('rackLabel uses single piece when only one of rack number/row is set', () => {
    expect(readBookStorage({ book_rack_number: '12' }).rackLabel).toBe('12');
    expect(readBookStorage({ book_rack_row: 'B' }).rackLabel).toBe('B');
  });

  it('builds crateLabel from the number, prefixing a known color when set', () => {
    expect(
      readBookStorage({ book_crate_color: 'red', book_crate_number: '5' }).crateLabel,
    ).toBe('Red 5');
    // The number identifies the crate; color is an optional visual aid, so a
    // number with no color still shows.
    expect(readBookStorage({ book_crate_number: '5' }).crateLabel).toBe('5');
    // A color with no number is not a crate — the number is the identity.
    expect(readBookStorage({ book_crate_color: 'red' }).crateLabel).toBeNull();
  });

  it('shows the crate number even when the crate color is unknown/unset', () => {
    expect(
      readBookStorage({ book_crate_color: 'taupe', book_crate_number: '5' })
        .crateLabel,
    ).toBe('5');
  });

  it('trims whitespace + treats blank strings as missing', () => {
    const info = readBookStorage({
      book_rack_number: '   ',
      book_rack_row: ' A ',
      book_crate_color: 'blue',
      book_crate_number: ' 7 ',
      book_grade: '  3 ',
    });
    expect(info.rackNumber).toBeNull();
    expect(info.rackRow).toBe('A');
    expect(info.crateNumber).toBe('7');
    expect(info.grade).toBe('3');
    expect(info.crateLabel).toBe('Blue 7');
    expect(info.rackLabel).toBe('A');
  });
});

describe('formatCrateLabel (the ONE book-facing crate label)', () => {
  it('is the "Blue 42" DISPLAY form, deliberately NOT the "Blue #42" location name', () => {
    // deriveLocationName() owns "#"-style because locations.name is the crate
    // dedupe key (migration 0270). This one never reaches the database.
    expect(formatCrateLabel('blue', '42')).toBe('Blue 42');
    expect(formatCrateLabel('blue', '42')).not.toBe('Blue #42');
  });

  it('falls back to the bare number when the color is unset or unknown', () => {
    expect(formatCrateLabel(null, '5')).toBe('5');
    expect(formatCrateLabel('taupe', '5')).toBe('5');
  });

  it('returns null with no number — the number is the crate identity', () => {
    expect(formatCrateLabel('red', null)).toBeNull();
    expect(formatCrateLabel(null, null)).toBeNull();
    expect(formatCrateLabel('red', '   ')).toBeNull();
  });

  it('labels the real free-text production crate numbers verbatim', () => {
    // Live data carries "Bin", "BIN" and "Blue Shelf" as crate NUMBERS.
    expect(formatCrateLabel('blue', 'Bin')).toBe('Blue Bin');
    expect(formatCrateLabel(null, 'Blue Shelf')).toBe('Blue Shelf');
  });

  it('readBookStorage().crateLabel is exactly formatCrateLabel (one rule, one implementation)', () => {
    for (const [color, number] of [
      ['red', '5'],
      ['taupe', '5'],
      ['red', null],
      [null, 'Bin'],
    ] as Array<[string | null, string | null]>) {
      expect(
        readBookStorage({ book_crate_color: color, book_crate_number: number }).crateLabel,
      ).toBe(formatCrateLabel(color, number));
    }
  });
});

describe('formatCrateLocationName (the "#"-style locations.name / DEDUPE KEY)', () => {
  it('is the "Blue #42" form, deliberately NOT the "Blue 42" display label', () => {
    // Migration 0270 keys crate identity on lower(name) — this shape IS the
    // dedupe key and must not drift toward formatCrateLabel's spelling.
    expect(formatCrateLocationName('blue', '42')).toBe('Blue #42');
    expect(formatCrateLocationName('blue', '42')).not.toBe(formatCrateLabel('blue', '42'));
  });

  it('renders a known slug through its registry LABEL, whatever case it arrives in', () => {
    expect(formatCrateLocationName('blue', '42')).toBe('Blue #42');
    expect(formatCrateLocationName('Blue', '42')).toBe('Blue #42');
  });

  it('keeps an UNKNOWN color verbatim — a location name stays reconstructible', () => {
    expect(formatCrateLocationName('taupe', '42')).toBe('taupe #42');
  });

  it('a NUMBER with no color is still a crate: "Crate #42"', () => {
    expect(formatCrateLocationName(null, '42')).toBe('Crate #42');
    expect(formatCrateLocationName('  ', '42')).toBe('Crate #42');
  });

  it('names the real free-text production crate numbers', () => {
    expect(formatCrateLocationName('blue', 'Bin')).toBe('Blue #Bin');
    expect(formatCrateLocationName(null, 'Blue Shelf')).toBe('Crate #Blue Shelf');
  });

  it('returns "" with no number so the caller can fall back to the rack number', () => {
    expect(formatCrateLocationName('blue', null)).toBe('');
    expect(formatCrateLocationName(null, null)).toBe('');
    expect(formatCrateLocationName('blue', '   ')).toBe('');
  });
});
