/**
 * ISBN checksums and search keys, shared by the web server and the phone.
 *
 * Books keep their ISBN in `inventory_items.barcode` (and, on older imports,
 * in custom_fields isbn / isbn13 / isbn10). Nothing checks those values, so
 * a stored barcode may be hyphenated, may fail its checksum, or may not be an
 * ISBN at all. This module answers two narrow questions and never rewrites a
 * stored value:
 *
 *   1. Is this text a checksum-valid ISBN-10 or ISBN-13? (isValidIsbn) The
 *      Book Order Totals report labels an identifier "ISBN" only when it is,
 *      and "Barcode" otherwise.
 *   2. Which exact keys should a search for this text compare against the
 *      stored identifiers, stripped to digits and X? (isbnSearchKeys) A
 *      checksum-valid ISBN-10 also finds its ISBN-13 (978 prefix) and the
 *      reverse, so "0-14-044913-2" finds a book stored as
 *      "978-0-14-044913-6". Anything else returns null and is matched as
 *      plain text instead (an invalid-checksum barcode is still found by its
 *      characters, never excluded).
 *
 * The 10 <-> 13 conversion is the same rule as the web's isbnVariants
 * (apps/web/src/lib/books/isbn-variants.ts); a web test holds the two equal
 * over generated inputs. That helper stays where it is.
 *
 * Pure: no I/O, no platform API.
 */

/** Spaces and hyphens dropped, x upper-cased. Returns the ten- or
 *  thirteen-character form when the text has that shape (ten characters, the
 *  last a digit or X; or thirteen digits), else null. No checksum here. */
export function normalizeIsbnInput(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s) || /^\d{13}$/.test(s)) return s;
  return null;
}

function isbn10CheckDigit(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(first9[i]);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}

function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(first12[i]);
  return String((10 - (sum % 10)) % 10);
}

/** A checksum-valid ISBN-10 (after dropping spaces and hyphens). */
export function isValidIsbn10(raw: string | null | undefined): boolean {
  const s = normalizeIsbnInput(raw);
  if (!s || s.length !== 10) return false;
  return isbn10CheckDigit(s.slice(0, 9)) === s[9];
}

/** A checksum-valid ISBN-13 starting 978 or 979 (after dropping spaces and
 *  hyphens). A thirteen-digit code with another prefix is an EAN, not an ISBN. */
export function isValidIsbn13(raw: string | null | undefined): boolean {
  const s = normalizeIsbnInput(raw);
  if (!s || s.length !== 13) return false;
  if (!s.startsWith('978') && !s.startsWith('979')) return false;
  return isbn13CheckDigit(s.slice(0, 12)) === s[12];
}

/** A checksum-valid ISBN-10 or ISBN-13. */
export function isValidIsbn(raw: string | null | undefined): boolean {
  return isValidIsbn10(raw) || isValidIsbn13(raw);
}

/**
 * The exact keys a search compares against stored identifiers (each stripped
 * to digits and X), or null when `q` is not a checksum-valid ISBN. Keys: the
 * normalized input, plus its ISBN-13 (for an ISBN-10) or its ISBN-10 (for a
 * 978 ISBN-13; a 979 ISBN-13 has no ISBN-10). At most two keys, each matching
 * the database's own shape check (^([0-9]{9}[0-9X]|[0-9]{13})$).
 */
export function isbnSearchKeys(q: string | null | undefined): string[] | null {
  const s = normalizeIsbnInput(q);
  if (!s) return null;
  if (s.length === 10) {
    if (!isValidIsbn10(s)) return null;
    const body = `978${s.slice(0, 9)}`;
    return [s, body + isbn13CheckDigit(body)];
  }
  if (!isValidIsbn13(s)) return null;
  if (s.startsWith('978')) {
    const core = s.slice(3, 12);
    return [s, core + isbn10CheckDigit(core)];
  }
  return [s];
}
