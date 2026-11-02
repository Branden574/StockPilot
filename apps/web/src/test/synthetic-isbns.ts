/**
 * Made-up ISBN-13s for tests (docket B76): generated in the 978-1-000 range
 * with a correct check digit, never copied from a list, so they stand for no
 * particular book.
 */

/** The ISBN-13 check digit of twelve digits (weights 1, 3, 1, 3, ...). */
function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += (i % 2 === 0 ? 1 : 3) * Number(first12[i]);
  return String((10 - (sum % 10)) % 10);
}

/** `count` different checksum-valid ISBN-13s, digits only, the n-th of them
 *  starting from `from`. */
export function syntheticIsbn13s(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, i) => {
    const first12 = `9781000${String(from + i).padStart(5, '0')}`;
    return first12 + isbn13CheckDigit(first12);
  });
}

/** An ISBN-13 written the way a book's barcode label prints it, with a dash
 *  after 978 and between the groups: 978-1-000-00012-3. */
export function dashedIsbn13(isbn: string): string {
  return [
    isbn.slice(0, 3),
    isbn.slice(3, 4),
    isbn.slice(4, 7),
    isbn.slice(7, 12),
    isbn.slice(12),
  ].join('-');
}
