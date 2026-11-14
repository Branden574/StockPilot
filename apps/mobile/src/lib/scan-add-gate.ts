/**
 * What the Scan tab says when a code or a photo matches nothing in the
 * workspace where no create control is offered (B124): the one-tap add cards
 * open only where screen-access.ts createControlOffer offers items:create.
 */
export const SCAN_CODE_NOT_FOUND = {
  title: 'Not found',
  message: 'Nothing in this workspace has this code.',
};

export const SCAN_PHOTO_NOT_FOUND = {
  title: 'Not found',
  message: 'Nothing in this workspace matches this photo.',
};

/** What the Scan tab says when the workspace's own items could not be read. */
export const SCAN_LOOKUP_FAILED = {
  title: 'Lookup failed',
  message:
    'This code could not be looked up in this workspace. Check your connection and try again.',
};

/** The same, for a photo: the workspace's own items could not be read. */
export const SCAN_PHOTO_LOOKUP_FAILED = {
  title: 'Lookup failed',
  message:
    'This photo could not be looked up in this workspace. Check your connection and try again.',
};

/**
 * The codes a photo carried, as the workspace's items are looked up by: a
 * product's UPC digits (11 to 14 of them, as the Scan tab's product lookup
 * takes), a book's ISBN as the server's book lookup normalizes it (digits and
 * X, upper case, 10 or 13 long). None when the photo reader read neither.
 */
export function photoCodes(vision: { kind?: string; upc?: string; isbn?: string }): string[] {
  if (vision.kind === 'product') {
    const upc = (vision.upc ?? '').replace(/\D/g, '');
    return upc.length >= 11 && upc.length <= 14 ? [upc] : [];
  }
  const isbn = (vision.isbn ?? '').replace(/[^0-9X]/gi, '').toUpperCase();
  return isbn.length === 10 || isbn.length === 13 ? [isbn] : [];
}
