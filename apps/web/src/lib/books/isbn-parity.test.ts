import { describe, expect, it } from 'vitest';

import { isbnSearchKeys, isValidIsbn } from '@stockpilot/core';

import { isbnVariants } from './isbn-variants';

/**
 * Core's isbnSearchKeys (the Book Order Totals search) and the web's
 * isbnVariants (receiving and PO matching) must convert ISBN-10 and ISBN-13
 * the same way. 500 generated checksum-valid inputs of each kind, written
 * with and without hyphens, must yield the same key set.
 */
function check10(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(first9[i]);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}
function check13(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(first12[i]);
  return String((10 - (sum % 10)) % 10);
}

let seed = 20260928;
function digits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    s += String(seed % 10);
  }
  return s;
}

describe('isbnSearchKeys agrees with isbnVariants', () => {
  it('on 500 generated ISBN-10s and 500 generated ISBN-13s (978 and 979)', () => {
    for (let i = 0; i < 500; i++) {
      const nine = digits(9);
      const isbn10 = nine + check10(nine);
      const prefix = i % 3 === 0 ? '979' : '978';
      const twelve = prefix + digits(9);
      const isbn13 = twelve + check13(twelve);
      for (const isbn of [isbn10, isbn13]) {
        expect(isValidIsbn(isbn)).toBe(true);
        const hyphenated = `${isbn.slice(0, 3)}-${isbn.slice(3, 7)}-${isbn.slice(7)}`;
        expect(new Set(isbnSearchKeys(hyphenated))).toEqual(new Set(isbnVariants(isbn)));
      }
    }
  });
});
