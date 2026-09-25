import { describe, expect, it } from 'vitest';

import { isIsbnSearch, isbnVariants } from './isbn-variants';

describe('isbnVariants', () => {
  it('expands an ISBN-10 to include its 978 ISBN-13 form', () => {
    // 0306406152 (ISBN-10) ⇄ 9780306406157 (ISBN-13) — the canonical example.
    const v = isbnVariants('0306406152');
    expect(v).toContain('0306406152');
    expect(v).toContain('9780306406157');
  });

  it('expands a 978 ISBN-13 to include its ISBN-10 form', () => {
    const v = isbnVariants('9780306406157');
    expect(v).toContain('9780306406157');
    expect(v).toContain('0306406152');
  });

  it('round-trips: both forms produce the same variant set', () => {
    expect(new Set(isbnVariants('0306406152'))).toEqual(new Set(isbnVariants('9780306406157')));
  });

  it('handles an ISBN-10 whose check digit is X', () => {
    // 097522980X (ISBN-10, X check) → 9780975229804 (ISBN-13).
    const v = isbnVariants('097522980X');
    expect(v).toContain('097522980X');
    expect(v).toContain('9780975229804');
  });

  it('does NOT fabricate an ISBN-10 for a 979-prefixed ISBN-13 (no ISBN-10 exists)', () => {
    const v = isbnVariants('9791234567896');
    expect(v).toEqual(['9791234567896']);
  });

  it('strips dashes/spaces before expanding', () => {
    expect(isbnVariants('978-0-306-40615-7')).toContain('0306406152');
  });

  it('returns [] for anything that is not a 10/13-length ISBN', () => {
    expect(isbnVariants('12345')).toEqual([]);
    expect(isbnVariants('')).toEqual([]);
  });
});

describe('isIsbnSearch', () => {
  it('accepts an ISBN-10 (X check digit too) and a 978/979 ISBN-13, with or without hyphens', () => {
    expect(isIsbnSearch('0306406152')).toBe(true);
    expect(isIsbnSearch('014240733X')).toBe(true);
    expect(isIsbnSearch('014240733x')).toBe(true);
    expect(isIsbnSearch('9780306406157')).toBe(true);
    expect(isIsbnSearch('978-0-306-40615-7')).toBe(true);
    expect(isIsbnSearch('9791234567896')).toBe(true);
  });

  it('refuses a code that only CONTAINS ten or thirteen digits, which isbnVariants would expand', () => {
    // The picker's failure case: a SKU mixing letters with exactly 10 digits.
    expect(isbnVariants('ABC1234567890')).not.toEqual([]);
    expect(isIsbnSearch('ABC1234567890')).toBe(false);
    expect(isIsbnSearch('SKU-0306406152')).toBe(false);
    expect(isIsbnSearch('1234567890123')).toBe(false); // 13 digits, not 978/979
    expect(isIsbnSearch('03064X6152')).toBe(false); // X only as the check digit
    expect(isIsbnSearch('pencil')).toBe(false);
    expect(isIsbnSearch('')).toBe(false);
  });
});
