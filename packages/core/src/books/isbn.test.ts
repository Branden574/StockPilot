import { describe, expect, it } from 'vitest';

import {
  isbnSearchKeys,
  isValidIsbn,
  isValidIsbn10,
  isValidIsbn13,
  normalizeIsbnInput,
} from './isbn';

describe('normalizeIsbnInput', () => {
  it('drops spaces and hyphens and upper-cases x', () => {
    expect(normalizeIsbnInput('978-0-14-044913-6')).toBe('9780140449136');
    expect(normalizeIsbnInput(' 0 8044 2957 x ')).toBe('080442957X');
  });
  it('refuses other shapes (no checksum here)', () => {
    expect(normalizeIsbnInput('12345')).toBeNull();
    expect(normalizeIsbnInput('97801404491361')).toBeNull();
    expect(normalizeIsbnInput('X123456789')).toBeNull();
    expect(normalizeIsbnInput('978.0.14.044913.6')).toBeNull();
    expect(normalizeIsbnInput(null)).toBeNull();
  });
});

describe('ISBN checksums', () => {
  it('accepts valid ISBN-10s, including an X check digit', () => {
    expect(isValidIsbn10('0306406152')).toBe(true);
    expect(isValidIsbn10('0-14-044913-2')).toBe(true);
    expect(isValidIsbn10('080442957X')).toBe(true);
    expect(isValidIsbn10('080442957x')).toBe(true);
  });
  it('refuses a failing ISBN-10 checksum', () => {
    expect(isValidIsbn10('0306406153')).toBe(false);
    expect(isValidIsbn10('0804429570')).toBe(false);
  });
  it('accepts valid 978 and 979 ISBN-13s and refuses bad checksums and other prefixes', () => {
    expect(isValidIsbn13('9780140449136')).toBe(true);
    expect(isValidIsbn13('978-0-306-40615-7')).toBe(true);
    expect(isValidIsbn13('9791032305690')).toBe(true);
    expect(isValidIsbn13('9780140449137')).toBe(false);
    // A valid EAN-13 that is not an ISBN.
    expect(isValidIsbn13('4006381333931')).toBe(false);
  });
  it('isValidIsbn is either form', () => {
    expect(isValidIsbn('0306406152')).toBe(true);
    expect(isValidIsbn('9780306406157')).toBe(true);
    expect(isValidIsbn('9780306406158')).toBe(false);
    expect(isValidIsbn('BK-123')).toBe(false);
    expect(isValidIsbn('')).toBe(false);
  });
});

describe('isbnSearchKeys', () => {
  it('an ISBN-10 also searches its ISBN-13', () => {
    expect(isbnSearchKeys('0-14-044913-2')).toEqual(['0140449132', '9780140449136']);
  });
  it('a 978 ISBN-13 also searches its ISBN-10; a 979 has none', () => {
    expect(isbnSearchKeys('978 0 306 40615 7')).toEqual(['9780306406157', '0306406152']);
    expect(isbnSearchKeys('9791032305690')).toEqual(['9791032305690']);
  });
  it('keeps an X check digit through the conversion', () => {
    expect(isbnSearchKeys('080442957X')).toEqual(['080442957X', '9780804429573']);
  });
  it('a failing checksum or a non-ISBN is not a key search (it stays a text search)', () => {
    expect(isbnSearchKeys('9780140449137')).toBeNull();
    expect(isbnSearchKeys('BK-123')).toBeNull();
    expect(isbnSearchKeys('Hobbit')).toBeNull();
    expect(isbnSearchKeys('')).toBeNull();
  });
  it('every key has the shape the database accepts', () => {
    for (const q of ['0306406152', '9780306406157', '080442957X', '9791032305690']) {
      for (const k of isbnSearchKeys(q) ?? []) expect(k).toMatch(/^([0-9]{9}[0-9X]|[0-9]{13})$/);
    }
  });
});
