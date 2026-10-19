/** The longest ISBN the item schema takes (its barcode field). */
const ISBN_MAX = 128;

/**
 * The ISBN a link hands this page (`?isbn=`, the Books scan shortcut's "Create
 * new book" when a scanned ISBN has no match): trimmed, and dropped when it is
 * blank, repeated or longer than the field takes. CONFLICTS D3: the shortcut
 * sent it and the page never read it, so the person typed it in again.
 */
export function isbnFromSearchParam(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string') return '';
  const isbn = raw.trim();
  return isbn.length > 0 && isbn.length <= ISBN_MAX ? isbn : '';
}
