import { describe, expect, it } from 'vitest';

import { isbnVariants } from './isbn-variants';

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
