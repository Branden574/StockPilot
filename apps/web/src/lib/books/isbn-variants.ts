/**
 * ISBN-10 ⇄ ISBN-13 variant expansion. A physical book can be printed with
 * either form, and our book inventory stores whichever was captured at creation
 * (barcode = ISBN). To match a PO line's ISBN against existing stock reliably we
 * compare against BOTH canonical forms.
 *
 * Pure + no I/O so it unit-tests in isolation.
 */

/** ISBN-10 check digit for the first 9 digits (weights 10..2). 'X' == 10. */
function isbn10CheckDigit(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(first9[i]);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}

/** ISBN-13 check digit for the first 12 digits (alternating weights 1,3). */
function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(first12[i]);
  return String((10 - (sum % 10)) % 10);
}

const isNumeric = (s: string) => /^[0-9]+$/.test(s);

/**
 * Given a normalized ISBN (10 or 13 chars, as produced by normalizeIsbn),
 * returns the deduped set of equivalent ISBN forms to match against — the input
 * plus its converted counterpart when a clean conversion exists:
 *   - ISBN-10  → adds the 978-prefixed ISBN-13.
 *   - ISBN-13  → adds the ISBN-10 (only for 978-prefixed; 979 has no ISBN-10).
 * Returns just the input (or [] for an unparseable value) when no conversion
 * applies, so callers can always match on the original too.
 */
export function isbnVariants(isbn: string): string[] {
  const s = (isbn ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  const out = new Set<string>();

  if (s.length === 10) {
    out.add(s);
    const core = s.slice(0, 9);
    if (isNumeric(core)) {
      const body = `978${core}`;
      out.add(body + isbn13CheckDigit(body));
    }
  } else if (s.length === 13) {
    if (!isNumeric(s)) return [];
    out.add(s);
    if (s.startsWith('978')) {
      const core = s.slice(3, 12); // the 9 significant digits after the 978 prefix
      out.add(core + isbn10CheckDigit(core));
    }
  } else {
    return [];
  }

  return [...out];
}
