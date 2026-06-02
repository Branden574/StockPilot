import { describe, expect, it } from 'vitest';

import { isLikelyIsbn, parseGoogleBooksVolume } from './google-books';

describe('isLikelyIsbn', () => {
  it('accepts 13- and 10-digit ISBNs with/without hyphens', () => {
    expect(isLikelyIsbn('9780306406157')).toBe(true);
    expect(isLikelyIsbn('978-0-306-40615-7')).toBe(true);
    expect(isLikelyIsbn('0306406152')).toBe(true);
    expect(isLikelyIsbn('0-306-40615-2')).toBe(true);
  });
  it('accepts a 10-digit ISBN with an X check digit (with/without hyphens)', () => {
    expect(isLikelyIsbn('080442957X')).toBe(true);
    expect(isLikelyIsbn('0-8044-2957-X')).toBe(true);
  });
  it('rejects non-ISBN barcodes and empties', () => {
    expect(isLikelyIsbn('ABC123')).toBe(false);
    expect(isLikelyIsbn('12345')).toBe(false);
    expect(isLikelyIsbn('')).toBe(false);
    expect(isLikelyIsbn(null)).toBe(false);
  });
});

describe('parseGoogleBooksVolume', () => {
  it('extracts price + metadata from a priced volume', () => {
    const json = {
      items: [
        {
          volumeInfo: {
            title: 'Test Book',
            authors: ['Jane Doe', 'John Roe'],
            averageRating: 4.5,
            ratingsCount: 12,
            categories: ['Fiction'],
            imageLinks: { thumbnail: 'http://img/x' },
            infoLink: 'http://books/x',
          },
          saleInfo: {
            saleability: 'FOR_SALE',
            listPrice: { amount: 19.99, currencyCode: 'USD' },
            retailPrice: { amount: 14.99, currencyCode: 'USD' },
          },
        },
      ],
    };
    const got = parseGoogleBooksVolume(json);
    expect(got).toMatchObject({
      title: 'Test Book',
      authors: 'Jane Doe, John Roe',
      listPrice: 19.99,
      retailPrice: 14.99,
      currency: 'USD',
      averageRating: 4.5,
      ratingsCount: 12,
      categories: 'Fiction',
      thumbnailUrl: 'http://img/x',
      infoLink: 'http://books/x',
      saleability: 'FOR_SALE',
    });
  });
  it('returns metadata with null prices when not for sale', () => {
    const json = { items: [{ volumeInfo: { title: 'NoSale' }, saleInfo: { saleability: 'NOT_FOR_SALE' } }] };
    const got = parseGoogleBooksVolume(json);
    expect(got).toMatchObject({ title: 'NoSale', listPrice: null, retailPrice: null, saleability: 'NOT_FOR_SALE' });
  });
  it('derives currency from listPrice when retailPrice is absent', () => {
    const json = {
      items: [
        {
          volumeInfo: { title: 'ListOnly' },
          saleInfo: { saleability: 'FOR_SALE', listPrice: { amount: 12.5, currencyCode: 'EUR' } },
        },
      ],
    };
    const got = parseGoogleBooksVolume(json);
    expect(got).toMatchObject({ listPrice: 12.5, retailPrice: null, currency: 'EUR' });
  });
  it('keeps a zero listPrice as 0 (not coerced to null)', () => {
    const json = {
      items: [
        {
          volumeInfo: { title: 'Free' },
          saleInfo: { saleability: 'FOR_SALE', listPrice: { amount: 0, currencyCode: 'USD' } },
        },
      ],
    };
    expect(parseGoogleBooksVolume(json)?.listPrice).toBe(0);
  });
  it('returns null when there are no items', () => {
    expect(parseGoogleBooksVolume({ totalItems: 0, items: [] })).toBeNull();
    expect(parseGoogleBooksVolume({})).toBeNull();
  });
  it('returns null when items is a non-array (number or string)', () => {
    expect(parseGoogleBooksVolume({ items: 5 })).toBeNull();
    expect(parseGoogleBooksVolume({ items: 'x' })).toBeNull();
  });
});
