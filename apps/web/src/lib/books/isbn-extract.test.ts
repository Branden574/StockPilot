import { describe, expect, it } from 'vitest';

import { isValidIsbn10, isValidIsbn13 } from '@stockpilot/core';

import { dashedIsbn13, syntheticIsbn13s } from '@/test/synthetic-isbns';

import { extractIsbnsFromText } from './isbn-extract';

/**
 * extractIsbnsFromText (docket B76). It runs an ISBN-13 pattern, then an
 * ISBN-10 pattern, over the same text, and the second pass did not know the
 * first one's matches. An ISBN-13 written with a dash or a space after its 978
 * or 979 prefix holds ten digits the ISBN-10 pattern also matches, so it was
 * counted twice: once as itself and once as a made-up ISBN-10 that fails its
 * checksum (or, for 979, as its first ten digits). The AI Assistant counted a
 * dashed list about twice, and Bulk ISBN import showed a failed lookup row for
 * each made-up ISBN-10.
 *
 * Now each checksum-valid ISBN-13 match is hidden from the ISBN-10 pass. A
 * 13-digit reading that fails its checksum is not hidden, so a real ISBN-10
 * after a stray "978" is still found. The order is unchanged: ISBN-13 hits
 * first (PO imports read only the first hit).
 */

describe('extractIsbnsFromText', () => {
  it('reads an ISBN-13 written with dashes or spaces once', () => {
    for (const text of ['978-0-306-40615-7', '978 0 306 40615 7', '978-0306406157']) {
      expect(extractIsbnsFromText(text), text).toEqual(['9780306406157']);
    }
    // A 979 ISBN-13 has no ISBN-10; its first ten digits were added as one.
    expect(extractIsbnsFromText('979-10-90636-07-1')).toEqual(['9791090636071']);
  });

  it('counts 26 dashed ISBN-13s as 26, not 52', () => {
    const isbns = syntheticIsbn13s(26);
    expect(isbns.every((isbn) => isValidIsbn13(isbn))).toBe(true);
    const list = isbns.map(dashedIsbn13).join('\n');
    expect(extractIsbnsFromText(list)).toEqual(isbns);
  });

  it('reads an ISBN-13 without separators, and an ISBN-10 on its own, as before', () => {
    expect(extractIsbnsFromText('9780306406157')).toEqual(['9780306406157']);
    expect(extractIsbnsFromText('0-306-40615-2')).toEqual(['0306406152']);
    expect(isValidIsbn10('0306406152')).toBe(true);
  });

  it('keeps a real ISBN-10 beside an ISBN-13, with the ISBN-13 first', () => {
    // PO imports read the first hit only (po-imports-lines.ts), so ISBN-13
    // hits stay ahead of ISBN-10 hits.
    expect(extractIsbnsFromText('ABC 978-0-306-40615-7 0306406152')).toEqual([
      '9780306406157',
      '0306406152',
    ]);
  });

  it('still finds a real ISBN-10 after a stray 978 (that 13-digit reading fails its checksum)', () => {
    expect(isValidIsbn13('9780306406152')).toBe(false);
    expect(extractIsbnsFromText('978 0306406152')).toContain('0306406152');
  });
});
