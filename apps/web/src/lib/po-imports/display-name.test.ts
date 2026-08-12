import { describe, expect, it } from 'vitest';

import { prettifyFileNameForDisplay } from './display-name';

import { poImportDisplayNameError } from '@stockpilot/core';

/** One character, by codepoint — see po-imports.display-name.test.ts on why. */
const ch = (codePoint: number) => String.fromCodePoint(codePoint);

/**
 * The upload form's PREFILL suggestion. It only has to produce a decent first
 * draft — the field is editable and the real uploaded file is never renamed —
 * but it must never produce something the name rules would then refuse.
 */
describe('prettifyFileNameForDisplay', () => {
  it('drops the extension and turns separators into spaces', () => {
    expect(prettifyFileNameForDisplay('Aug_2026-DC4_book_order.pdf')).toBe(
      'Aug 2026 DC4 book order',
    );
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(prettifyFileNameForDisplay('  Aug___2026 --  DC4  .csv')).toBe('Aug 2026 DC4');
  });

  it('drops only the LAST extension — an inner dot is a word the user typed', () => {
    expect(prettifyFileNameForDisplay('po_final.v2.pdf')).toBe('po final.v2');
  });

  it('leaves a name with no extension alone', () => {
    expect(prettifyFileNameForDisplay('August DC4 Book Order')).toBe('August DC4 Book Order');
  });

  it('returns empty string when nothing usable is left', () => {
    expect(prettifyFileNameForDisplay('.pdf')).toBe('');
    expect(prettifyFileNameForDisplay('___.csv')).toBe('');
  });

  it('clips to the 160-character ceiling so the suggestion is always acceptable', () => {
    expect(prettifyFileNameForDisplay(`${'a'.repeat(300)}.pdf`)).toHaveLength(160);
  });

  it('drops control characters and bidi overrides the name rules would refuse', () => {
    // `a<U+202E>b.csv` — the RTL-override filename. Left in, the prefill would
    // be refused by the server AFTER the file had already been PUT to Storage,
    // over a character the user cannot see.
    expect(prettifyFileNameForDisplay(`a${ch(0x202e)}b.csv`)).toBe('ab');
    expect(poImportDisplayNameError('ab')).toBeNull();

    expect(prettifyFileNameForDisplay(`invoice${ch(0x2066)}fdp.pdf`)).toBe('invoicefdp');
    expect(prettifyFileNameForDisplay(`Aug${ch(0x00)}_2026${ch(0x1b)}.csv`)).toBe('Aug 2026');
  });

  it('a name that is ONLY unsafe characters comes back empty, not refused', () => {
    expect(prettifyFileNameForDisplay(`${ch(0x202e)}${ch(0x7f)}.csv`)).toBe('');
  });

  it('camera filenames still prettify to something (even if not useful) — hence no prefill on the scan form', () => {
    expect(prettifyFileNameForDisplay('image.jpg')).toBe('image');
    expect(prettifyFileNameForDisplay('IMG_4471.HEIC')).toBe('IMG 4471');
  });
});
