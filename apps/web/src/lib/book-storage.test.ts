import { describe, expect, it } from 'vitest';

import {
  formatGrade,
  getCrateColor,
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

  it('formats crateLabel only when both color and number present', () => {
    expect(
      readBookStorage({ book_crate_color: 'red', book_crate_number: '5' }).crateLabel,
    ).toBe('Red 5');
    expect(readBookStorage({ book_crate_color: 'red' }).crateLabel).toBeNull();
    expect(readBookStorage({ book_crate_number: '5' }).crateLabel).toBeNull();
  });

  it('ignores crateLabel when crate color is unknown', () => {
    expect(
      readBookStorage({ book_crate_color: 'taupe', book_crate_number: '5' })
        .crateLabel,
    ).toBeNull();
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
