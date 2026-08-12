import { describe, expect, it } from 'vitest';

import { prettifyFileNameForDisplay } from './display-name';

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

  it('camera filenames still prettify to something (even if not useful) — hence no prefill on the scan form', () => {
    expect(prettifyFileNameForDisplay('image.jpg')).toBe('image');
    expect(prettifyFileNameForDisplay('IMG_4471.HEIC')).toBe('IMG 4471');
  });
});
