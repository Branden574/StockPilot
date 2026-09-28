/**
 * Hosts the book-lookup pipeline ever returns cover images from. Shared by
 * the bulk-import cover rehost (books-import.ts: anything else is refused, so
 * a poisoned lookup answer cannot turn the import into an SSRF probe) and by
 * the report paths that show or fetch an item's legacy
 * custom_fields.thumbnail_url (the Book Order Totals cover trust filter and
 * the PDF image prefetch).
 *
 * Matching is by host OR any subdomain of a listed host, the SSRF guard's own
 * rule (safeFetch hostAllowlist): Open Library covers redirect to
 * ia*.us.archive.org, which "archive.org" covers.
 */
export const COVER_HOST_ALLOWLIST: readonly string[] = [
  'books.google.com',
  'books.googleusercontent.com',
  'covers.openlibrary.org',
  'archive.org',
  'ia801600.us.archive.org',
  'ia803000.us.archive.org',
  'www.loc.gov',
  'tile.loc.gov',
];

/** A host, or a subdomain of a host, on the cover allowlist. */
export function isAllowedCoverHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return COVER_HOST_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
